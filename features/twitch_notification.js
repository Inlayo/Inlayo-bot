const axios = require("axios");
const fs = require("fs");
const path = require("path");
const {
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
} = require("discord.js");

const SETTINGS_DIR = path.join(__dirname, "twitch_notification", "settings");
const THUMBNAIL_DIR = path.join(__dirname, "twitch_notification", "thumbnails");

const TWITCH_API_BASE = "https://api.twitch.tv/helix";
const TWITCH_AUTH_URL = "https://id.twitch.tv/oauth2/token";
const TWITCH_CHECK_INTERVAL = 60 * 1000;
const TWITCH_TOKEN_REFRESH_INTERVAL = 60 * 60 * 1000;
const PREFIX = "!t";
const MAX_USER_IDS_PER_REQUEST = 100;

let client = null;
let twitchToken = null;
let checkTimer = null;
let tokenTimer = null;
let isCheckingStreams = false;
let isRefreshingToken = false;

const api = axios.create({
  timeout: 15_000,
});

function ensureDirectories() {
  fs.mkdirSync(SETTINGS_DIR, { recursive: true });
  fs.mkdirSync(THUMBNAIL_DIR, { recursive: true });
}

function createDefaultSettings() {
  return {
    streamers: [],
    liveStatus: {},
  };
}

function getSettingsPath(channelId) {
  return path.join(SETTINGS_DIR, `${channelId}.json`);
}

function normalizeSettings(settings) {
  const streamers = Array.isArray(settings?.streamers)
    ? settings.streamers
        .filter((streamer) => streamer && streamer.name)
        .map((streamer) => ({
          name: String(streamer.name).toLowerCase(),
          id: streamer.id ? String(streamer.id) : null,
        }))
    : [];

  const liveStatus =
    settings?.liveStatus && typeof settings.liveStatus === "object"
      ? settings.liveStatus
      : {};

  return { streamers, liveStatus };
}

function loadChannelSettings(channelId) {
  const file = getSettingsPath(channelId);

  if (!fs.existsSync(file)) {
    return createDefaultSettings();
  }

  try {
    return normalizeSettings(JSON.parse(fs.readFileSync(file, "utf8")));
  } catch (error) {
    console.error(
      `Failed to load Twitch settings for channel ${channelId}:`,
      error.message,
    );
    return createDefaultSettings();
  }
}

function saveChannelSettings(channelId, settings) {
  const file = getSettingsPath(channelId);
  const tempFile = `${file}.tmp`;

  try {
    fs.writeFileSync(tempFile, JSON.stringify(settings, null, 2), "utf8");
    fs.renameSync(tempFile, file);
  } catch (error) {
    console.error(
      `Failed to save Twitch settings for channel ${channelId}:`,
      error.message,
    );

    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch {
      // Ignore cleanup errors for the temporary file.
    }
  }
}

function getAllChannelIds() {
  try {
    return fs
      .readdirSync(SETTINGS_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.endsWith(".json"))
      .map((entry) => path.basename(entry.name, ".json"));
  } catch (error) {
    console.error("Failed to read Twitch settings directory:", error.message);
    return [];
  }
}

function getTwitchHeaders() {
  return {
    "Client-ID": process.env.TWITCH_CLIENT_ID,
    Authorization: `Bearer ${twitchToken}`,
  };
}

function isTwitchConfigured() {
  return Boolean(process.env.TWITCH_CLIENT_ID && process.env.TWITCH_SECRET);
}

function getAxiosErrorMessage(error) {
  return error.response?.data?.message || error.message;
}

async function fetchTwitchToken() {
  if (isRefreshingToken) {
    return;
  }

  isRefreshingToken = true;

  try {
    if (!isTwitchConfigured()) {
      twitchToken = null;
      console.error("TWITCH_CLIENT_ID or TWITCH_SECRET is not configured.");
      return;
    }

    const response = await api.post(TWITCH_AUTH_URL, null, {
      params: {
        client_id: process.env.TWITCH_CLIENT_ID,
        client_secret: process.env.TWITCH_SECRET,
        grant_type: "client_credentials",
      },
    });

    const token = response.data?.access_token;
    if (!token) {
      throw new Error("Twitch did not return an access token.");
    }

    twitchToken = token;
    console.log("Twitch access token refreshed successfully.");
  } catch (error) {
    console.error(
      "Failed to refresh Twitch access token:",
      getAxiosErrorMessage(error),
    );
    // Keep the previous token. A transient refresh failure should not take a
    // working bot offline immediately.
  } finally {
    isRefreshingToken = false;
  }
}

async function getTwitchUsersByIds(ids) {
  const uniqueIds = [...new Set(ids.filter(Boolean).map(String))];
  if (uniqueIds.length === 0) {
    return [];
  }

  const response = await api.get(`${TWITCH_API_BASE}/users`, {
    params: uniqueIds.reduce((params, id) => {
      params.id = params.id ? [...params.id, id] : [id];
      return params;
    }, {}),
    headers: getTwitchHeaders(),
  });

  return response.data?.data ?? [];
}

async function getTwitchUserByLogin(login) {
  const response = await api.get(`${TWITCH_API_BASE}/users`, {
    params: { login },
    headers: getTwitchHeaders(),
  });

  return response.data?.data?.[0] ?? null;
}

async function getTwitchStreamsByUserIds(userIds) {
  const ids = [...new Set(userIds.filter(Boolean).map(String))];
  if (ids.length === 0) {
    return [];
  }

  const streams = [];

  for (let i = 0; i < ids.length; i += MAX_USER_IDS_PER_REQUEST) {
    const chunk = ids.slice(i, i + MAX_USER_IDS_PER_REQUEST);
    const params = new URLSearchParams();
    for (const id of chunk) {
      params.append("user_id", id);
    }

    const response = await api.get(`${TWITCH_API_BASE}/streams?${params}`, {
      headers: getTwitchHeaders(),
    });

    streams.push(...(response.data?.data ?? []));
  }

  return streams;
}

async function addStreamer(channelId, name) {
  const normalizedName = name.replace(/^@/, "").trim().toLowerCase();
  if (!normalizedName) {
    return "Please provide a streamer name.";
  }

  const settings = loadChannelSettings(channelId);

  if (settings.streamers.some((streamer) => streamer.name === normalizedName)) {
    return "Streamer already exists in this channel.";
  }

  if (!twitchToken) {
    return "Twitch is not ready yet. Please try again later.";
  }

  try {
    const user = await getTwitchUserByLogin(normalizedName);
    if (!user) {
      return "Twitch user not found.";
    }

    settings.streamers.push({
      name: user.login.toLowerCase(),
      id: String(user.id),
    });
    settings.liveStatus[String(user.id)] = false;

    saveChannelSettings(channelId, settings);
    return `Streamer ${user.login} added to this channel.`;
  } catch (error) {
    console.error(
      `Failed to add Twitch streamer ${normalizedName}:`,
      getAxiosErrorMessage(error),
    );
    return "Failed to add streamer. Please try again later.";
  }
}

function deleteStreamer(channelId, name) {
  const normalizedName = name.replace(/^@/, "").trim().toLowerCase();
  const settings = loadChannelSettings(channelId);
  const streamer = settings.streamers.find(
    (entry) => entry.name === normalizedName,
  );

  if (!streamer) {
    return "Streamer not found in this channel.";
  }

  settings.streamers = settings.streamers.filter(
    (entry) => entry.name !== normalizedName,
  );

  if (streamer.id) {
    delete settings.liveStatus[streamer.id];
  }
  delete settings.liveStatus[normalizedName];

  saveChannelSettings(channelId, settings);
  return `Streamer ${normalizedName} removed from this channel.`;
}

function listStreamers(channelId) {
  const settings = loadChannelSettings(channelId);

  if (settings.streamers.length === 0) {
    return "No streamers saved in this channel.";
  }

  return [
    "**Streamers:**",
    ...settings.streamers.map(
      (streamer) => `• \`${streamer.name}\` (ID: ${streamer.id ?? "unknown"})`,
    ),
  ].join("\n");
}

function ensureChannelFile(channelId) {
  const file = getSettingsPath(channelId);
  if (!fs.existsSync(file)) {
    saveChannelSettings(channelId, createDefaultSettings());
    return true;
  }

  return false;
}

function getStreamerLiveStatus(settings, streamer) {
  if (streamer.id && settings.liveStatus[streamer.id] !== undefined) {
    return Boolean(settings.liveStatus[streamer.id]);
  }

  return Boolean(settings.liveStatus[streamer.name]);
}

function setStreamerLiveStatus(settings, streamer, value) {
  const key = streamer.id || streamer.name;
  settings.liveStatus[key] = value;

  if (streamer.id) {
    delete settings.liveStatus[streamer.name];
  }
}

function removeOldThumbnails(login) {
  try {
    const files = fs
      .readdirSync(THUMBNAIL_DIR, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.startsWith(`${login}_`));

    for (const file of files) {
      try {
        fs.unlinkSync(path.join(THUMBNAIL_DIR, file.name));
      } catch (error) {
        console.error(
          `Failed to remove Twitch thumbnail ${file.name}:`,
          error.message,
        );
      }
    }
  } catch (error) {
    console.error("Failed to scan Twitch thumbnail directory:", error.message);
  }
}

async function downloadThumbnail(url, filename) {
  const filepath = path.join(THUMBNAIL_DIR, filename);

  try {
    const response = await api.get(url, {
      responseType: "arraybuffer",
    });

    fs.writeFileSync(filepath, response.data);
    return filepath;
  } catch (error) {
    console.error(
      `Failed to download Twitch thumbnail ${filename}:`,
      getAxiosErrorMessage(error),
    );
    return null;
  }
}

async function sendLiveNotification(streamInfo, userInfo, channelId) {
  let channel;

  try {
    channel = await client.channels.fetch(channelId);
  } catch (error) {
    console.error(
      `Failed to fetch Discord channel ${channelId}:`,
      error.message,
    );
    return false;
  }

  if (!channel?.isTextBased?.() || !channel.send) {
    console.error(`Discord channel ${channelId} is not text-based.`);
    return false;
  }

  const login = streamInfo.user_login.toLowerCase();
  const streamUrl = `https://twitch.tv/${login}`;
  const embed = new EmbedBuilder()
    .setAuthor({
      name: `${login} is now live on Twitch!`,
      iconURL: userInfo.profile_image_url,
      url: streamUrl,
    })
    .setTitle(streamInfo.title || "No title")
    .setURL(streamUrl)
    .setColor("#9146FF")
    .setFooter({ text: "made by Inlayo" })
    .setTimestamp();

  if (streamInfo.game_name) {
    embed.addFields({
      name: "Game",
      value: streamInfo.game_name,
      inline: true,
    });
  }

  removeOldThumbnails(login);

  let thumbnailPath = null;
  if (streamInfo.thumbnail_url) {
    const timestamp = Date.now();
    const filename = `${login}_${timestamp}.jpg`;
    const thumbnailUrl =
      streamInfo.thumbnail_url
        .replace("{width}", "1280")
        .replace("{height}", "720") + `?t=${timestamp}`;

    thumbnailPath = await downloadThumbnail(thumbnailUrl, filename);
    if (thumbnailPath) {
      embed.setImage(`attachment://${filename}`);
    }
  }

  const components = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setLabel("Watch Stream")
      .setStyle(ButtonStyle.Link)
      .setURL(streamUrl),
  );

  const files = thumbnailPath
    ? [
        {
          attachment: thumbnailPath,
          name: path.basename(thumbnailPath),
        },
      ]
    : [];

  try {
    await channel.send({
      embeds: [embed],
      components: [components],
      files,
    });

    console.log(
      `Sent a live notification for ${login} in channel ${channelId}.`,
    );
    return true;
  } catch (error) {
    console.error(
      `Failed to send a live notification for ${login}:`,
      error.message,
    );
    return false;
  }
}

async function checkChannel(channelId) {
  const settings = loadChannelSettings(channelId);
  if (settings.streamers.length === 0) {
    return;
  }

  const streamersWithoutId = settings.streamers.filter(
    (streamer) => !streamer.id,
  );

  for (const streamer of streamersWithoutId) {
    try {
      const user = await getTwitchUserByLogin(streamer.name);
      if (user) {
        streamer.id = String(user.id);
        streamer.name = user.login.toLowerCase();
        settings.liveStatus[streamer.id] ??= false;
      }
    } catch (error) {
      console.error(
        `Failed to resolve Twitch streamer ${streamer.name}:`,
        getAxiosErrorMessage(error),
      );
    }
  }

  if (settings.streamers.some((streamer) => !streamer.id)) {
    saveChannelSettings(channelId, settings);
  }

  const streamers = settings.streamers.filter((streamer) => streamer.id);
  if (streamers.length === 0) {
    return;
  }

  const streams = await getTwitchStreamsByUserIds(
    streamers.map((streamer) => streamer.id),
  );
  const liveStreams = new Map(
    streams.map((stream) => [String(stream.user_id), stream]),
  );

  const liveUserIds = streams.map((stream) => String(stream.user_id));
  const users = await getTwitchUsersByIds(liveUserIds);
  const usersById = new Map(users.map((user) => [String(user.id), user]));

  let changed = false;

  for (const streamer of streamers) {
    const streamInfo = liveStreams.get(String(streamer.id));
    const wasLive = getStreamerLiveStatus(settings, streamer);

    if (!streamInfo) {
      if (wasLive) {
        setStreamerLiveStatus(settings, streamer, false);
        changed = true;
        console.log(`${streamer.name} stopped streaming.`);
      }
      continue;
    }

    if (wasLive) {
      continue;
    }

    const userInfo = usersById.get(String(streamer.id));
    if (!userInfo) {
      console.error(
        `Failed to get Twitch user information for ${streamer.name}.`,
      );
      continue;
    }

    const sent = await sendLiveNotification(streamInfo, userInfo, channelId);
    if (sent) {
      setStreamerLiveStatus(settings, streamer, true);
      changed = true;
      console.log(`${streamer.name} started streaming: ${streamInfo.title}`);
    }
  }

  if (changed) {
    saveChannelSettings(channelId, settings);
  }
}

async function checkStreams() {
  if (!twitchToken || !client || isCheckingStreams) {
    return;
  }

  isCheckingStreams = true;

  try {
    for (const channelId of getAllChannelIds()) {
      try {
        await checkChannel(channelId);
      } catch (error) {
        console.error(
          `Failed to check Twitch streams for channel ${channelId}:`,
          getAxiosErrorMessage(error),
        );
      }
    }
  } finally {
    isCheckingStreams = false;
  }
}

async function handleMessage(message) {
  if (
    message.author.bot ||
    !message.guild ||
    !message.content.toLowerCase().startsWith(PREFIX)
  ) {
    return;
  }

  const input = message.content.slice(PREFIX.length).trim();
  const [command, rawName] = input.split(/\s+/, 2);
  const normalizedCommand = command?.toLowerCase();
  const channelId = message.channel.id;

  switch (normalizedCommand) {
    case "channel":
      ensureChannelFile(channelId);
      await message.reply(
        "This channel is now set up for stream notifications. Use `!t add <streamer>` to add streamers.",
      );
      break;

    case "add":
      await message.reply(await addStreamer(channelId, rawName ?? ""));
      break;

    case "delete":
      if (!rawName) {
        await message.reply("Please provide a streamer name.");
        break;
      }
      await message.reply(deleteStreamer(channelId, rawName));
      break;

    case "list":
      await message.reply(listStreamers(channelId));
      break;

    default:
      await message.reply("Commands: channel, add, delete, list");
  }
}

async function initialize(discordClient) {
  if (client) {
    return;
  }

  client = discordClient;
  ensureDirectories();

  await fetchTwitchToken();

  if (!tokenTimer) {
    tokenTimer = setInterval(() => {
      void fetchTwitchToken();
    }, TWITCH_TOKEN_REFRESH_INTERVAL);
    tokenTimer.unref?.();
  }

  if (!checkTimer) {
    checkTimer = setInterval(() => {
      void checkStreams();
    }, TWITCH_CHECK_INTERVAL);
    checkTimer.unref?.();
  }

  await checkStreams();
  console.log("Twitch notifications initialized.");
}

function destroy() {
  if (tokenTimer) {
    clearInterval(tokenTimer);
    tokenTimer = null;
  }

  if (checkTimer) {
    clearInterval(checkTimer);
    checkTimer = null;
  }

  client = null;
  twitchToken = null;
}

function getStatus() {
  return {
    token: Boolean(twitchToken),
    channels: getAllChannelIds().length,
    checking: isCheckingStreams,
  };
}

module.exports = {
  initialize,
  handleMessage,
  getStatus,
  destroy,
};
