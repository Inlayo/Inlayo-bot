const axios = require("axios");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");
const {
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  EmbedBuilder,
  REST,
  Routes,
  SlashCommandBuilder,
} = require("discord.js");

const API_TIMEOUT = 15_000;
const ACCOUNT_FILE = path.join(__dirname, "data", "osu_accounts.json");
const TOP_PAGE_SIZE = 5;
const TOP_SESSION_TTL = 15 * 60 * 1000;
const TOP_COMPONENT_PREFIX = "osu_top";
const topPaginationSessions = new Map();
const MODS = [
  [1, "NF"],
  [2, "EZ"],
  [4, "TD"],
  [8, "HD"],
  [16, "HR"],
  [32, "SD"],
  [64, "DT"],
  [128, "RX"],
  [256, "HT"],
  [512, "NC"],
  [1024, "FL"],
  [2048, "AT"],
  [4096, "SO"],
  [8192, "AP"],
  [16384, "PF"],
  [32768, "4K"],
  [65536, "5K"],
  [131072, "6K"],
  [262144, "7K"],
  [524288, "8K"],
  [1048576, "FI"],
  [2097152, "RD"],
  [4194304, "CN"],
  [8388608, "TP"],
  [16777216, "9K"],
  [536870912, "V2"],
];
const MODES = [
  { name: "osu!", value: 0 },
  { name: "taiko!", value: 1 },
  { name: "catch!", value: 2 },
  { name: "mania!", value: 3 },
];
const SUPPORTED_MODES = [
  ...MODES,
  { name: "rx!std", value: 4 },
  { name: "rx!taiko", value: 5 },
  { name: "rx!catch", value: 6 },
  { name: "ap!std", value: 8 },
];
const MODE_TOKENS = new Map(
  SUPPORTED_MODES.map(({ name, value }) => [name.toLowerCase(), value]),
);
const MODE_NAMES = new Map([
  ...MODES.map(({ name, value }) => [value, name]),
  [4, "rx!std"],
  [5, "rx!taiko"],
  [6, "rx!catch"],
  [8, "ap!std"],
]);

const COMMANDS = [
  {
    type: "profile",
    mode: 0,
    names: ["profile"],
    description: "View a player's profile and mode statistics on Inlayo's osu private server.",
  },
  {
    type: "profile",
    mode: 3,
    names: ["profilemania", "maniaprofile", "profilem"],
    description: "View a player's mania profile on Inlayo's osu private server.",
  },
  {
    type: "profile",
    mode: 1,
    names: ["profiletaiko", "taikoprofile", "profilet"],
    description: "View a player's taiko profile on Inlayo's osu private server.",
  },
  {
    type: "profile",
    mode: 2,
    names: [
      "profilectb",
      "ctbprofile",
      "profilec",
      "profilecatch",
      "catchprofile",
      "catch",
      "catchthebeat",
      "fruits",
    ],
    description: "View a player's catch profile on Inlayo's osu private server.",
  },
  {
    type: "top",
    mode: 0,
    names: ["top", "topscores", "toposu", "topstd", "topstandard", "topo", "tops", "t"],
    description: "View a player's top scores on Inlayo's osu private server.",
  },
  {
    type: "top",
    mode: 3,
    names: ["topmania", "topm", "tm"],
    description: "View a player's mania top scores on Inlayo's osu private server.",
  },
  {
    type: "top",
    mode: 1,
    names: ["toptaiko", "topt", "tt"],
    description: "View a player's taiko top scores on Inlayo's osu private server.",
  },
  {
    type: "top",
    mode: 2,
    names: ["topctb", "topc", "topcatch", "topcatchthebeat", "tc"],
    description: "View a player's catch top scores on Inlayo's osu private server.",
  },
  {
    type: "recent",
    mode: 0,
    names: ["recent", "r", "rs"],
    description: "View a player's recent scores on Inlayo's osu private server.",
  },
  {
    type: "recent",
    mode: 3,
    names: ["recentmania", "rm"],
    description: "View a player's recent mania scores on Inlayo's osu private server.",
  },
  {
    type: "recent",
    mode: 1,
    names: ["recenttaiko", "rt"],
    description: "View a player's recent taiko scores on Inlayo's osu private server.",
  },
  {
    type: "recent",
    mode: 2,
    names: ["recentctb", "rc", "recentcatch"],
    description: "View a player's recent catch scores on Inlayo's osu private server.",
  },
  {
    type: "recent",
    mode: 0,
    names: ["recentpass", "rp", "rps"],
    description: "View a player's most recent pass on Inlayo's osu private server.",
    passes: true,
  },
  {
    type: "recent",
    mode: 3,
    names: ["recentpassmania", "rpm"],
    description: "View a player's most recent mania pass on Inlayo's osu private server.",
    passes: true,
  },
  {
    type: "recent",
    mode: 1,
    names: ["recentpasstaiko"],
    description: "View a player's most recent taiko pass on Inlayo's osu private server.",
    passes: true,
  },
  {
    type: "recent",
    mode: 2,
    names: ["recentpassctb"],
    description: "View a player's most recent catch pass on Inlayo's osu private server.",
    passes: true,
  },
  {
    type: "link",
    mode: 0,
    names: ["link"],
    description: "Link your Discord account to a username on Inlayo's osu private server.",
  },
  {
    type: "unlink",
    mode: 0,
    names: ["unlink"],
    description: "Remove your linked username from Inlayo's osu private server.",
  },
];

const commandByName = new Map();
const commands = COMMANDS.flatMap((spec) =>
  spec.names.map((name) => {
    commandByName.set(name, spec);
    const command = new SlashCommandBuilder()
      .setName(name)
      .setDescription(spec.description);

    if (spec.type === "profile" || spec.type === "top" || spec.type === "recent") {
      command.addStringOption((option) =>
        option
          .setName("username")
          .setDescription("Username on Inlayo's osu private server (optional if linked)")
          .setRequired(false),
      );
    } else if (spec.type === "link") {
      command.addStringOption((option) =>
        option
          .setName("username")
          .setDescription("Your username on Inlayo's osu private server")
          .setRequired(true),
      );
    }

    if (
      name === spec.type &&
      ["profile", "top", "recent"].includes(spec.type)
    ) {
      command.addIntegerOption((option) =>
        addSupportedModeChoices(
          option.setName("mode").setDescription("Game mode"),
        ),
      );
    }

    if (spec.type === "top") {
      command.addIntegerOption((option) =>
        option
          .setName("limit")
          .setDescription("Number of scores to display (1-10)")
          .setMinValue(1)
          .setMaxValue(10),
      );
    }

    if (spec.type === "top" || spec.type === "recent") {
      command.addIntegerOption((option) =>
        option
          .setName("index")
          .setDescription("Score position to display (1-100)")
          .setMinValue(1)
          .setMaxValue(100),
      );
    }

    return command.toJSON();
  }),
);

function addSupportedModeChoices(option) {
  return option.addChoices(...SUPPORTED_MODES);
}

function getApiBaseUrl() {
  const configuredUrl = process.env.INLAYO_API_BASE;
  if (!configuredUrl) {
    throw new Error("INLAYO_API_BASE is not configured.");
  }

  const url = new URL(configuredUrl);
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("INLAYO_API_BASE must use HTTP or HTTPS.");
  }

  const basePath = url.pathname.replace(/\/+$/, "");
  return `${url.origin}${basePath}/v2`;
}

function getServerUrls() {
  const apiUrl = new URL(process.env.INLAYO_API_BASE);
  const serverHost = apiUrl.hostname.replace(/^api\./i, "");
  const serverOrigin = `${apiUrl.protocol}//${serverHost}${apiUrl.port ? `:${apiUrl.port}` : ""}`;

  return {
    profile: (playerId) => `${serverOrigin}/u/${playerId}`,
    avatar: (playerId) =>
      `${apiUrl.protocol}//a.${serverHost}${apiUrl.port ? `:${apiUrl.port}` : ""}/${playerId}`,
    beatmap: (beatmapId) =>
      `${apiUrl.protocol}//b.${serverHost}${apiUrl.port ? `:${apiUrl.port}` : ""}/${beatmapId}`,
    beatmapThumbnail: (beatmapsetId) =>
      `https://assets.ppy.sh/beatmaps/${beatmapsetId}/covers/list@2x.jpg`,
  };
}

function loadLinkedAccounts() {
  if (!fs.existsSync(ACCOUNT_FILE)) {
    return {};
  }

  const parsed = JSON.parse(fs.readFileSync(ACCOUNT_FILE, "utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Linked account data must be a JSON object.");
  }

  return parsed;
}

function getLinkedAccount(userId) {
  if (!userId) {
    return null;
  }

  const username = loadLinkedAccounts()[userId];
  return typeof username === "string" ? username : null;
}

function saveLinkedAccount(userId, username) {
  const accounts = loadLinkedAccounts();
  accounts[userId] = username;
  writeLinkedAccounts(accounts);
}

function writeLinkedAccounts(accounts) {
  fs.mkdirSync(path.dirname(ACCOUNT_FILE), { recursive: true });

  const temporaryFile = `${ACCOUNT_FILE}.tmp`;
  fs.writeFileSync(temporaryFile, JSON.stringify(accounts, null, 2), "utf8");
  fs.renameSync(temporaryFile, ACCOUNT_FILE);
}

function removeLinkedAccount(userId) {
  const accounts = loadLinkedAccounts();
  if (!Object.hasOwn(accounts, userId)) {
    return false;
  }

  delete accounts[userId];
  writeLinkedAccounts(accounts);
  return true;
}

function getDiscordUserId(interaction) {
  return interaction.user?.id ?? interaction.member?.user?.id ?? null;
}

async function apiGet(path, params) {
  const response = await axios.get(`${getApiBaseUrl()}${path}`, {
    params,
    timeout: API_TIMEOUT,
  });
  const payload = response.data;

  if (payload?.status !== "success") {
    const error = new Error(payload?.error || "Unexpected Inlayo API response.");
    error.response = { status: response.status };
    throw error;
  }

  return payload.data;
}

async function getPlayer(username) {
  const player = await apiGet(
    `/players/${encodeURIComponent(username)}`,
    { key: "username" },
  );

  if (!player || !Number.isInteger(player.id)) {
    throw new Error("Inlayo API returned an invalid player.");
  }

  return player;
}

async function getPlayerModeStats(playerId, mode) {
  return apiGet(`/players/${playerId}/stats/${mode}`);
}

async function getPlayerScores(
  playerId,
  mode,
  scope,
  limit,
  includeFailed,
  offset,
) {
  const scores = await apiGet(`/players/${playerId}/scores`, {
    scope,
    mode,
    limit,
    offset,
    include_failed: includeFailed,
    pp_only: scope === "best",
  });

  if (!Array.isArray(scores)) {
    throw new Error("Inlayo API returned an invalid score list.");
  }

  return scores;
}

function getOption(interaction, name) {
  return interaction.data.options?.find((option) => option.name === name)
    ?.value;
}

function getModeName(mode) {
  return MODE_NAMES.get(mode) ?? "osu!";
}

function getAccuracy(value) {
  const accuracy = Number(value);
  const percentage = accuracy <= 1 ? accuracy * 100 : accuracy;

  return `${percentage.toFixed(2)}%`;
}

function formatNumber(value) {
  return Number(value || 0).toLocaleString("en-US");
}

function formatPlaytime(seconds) {
  const totalMinutes = Math.floor(Number(seconds || 0) / 60);
  const hours = Math.floor(totalMinutes / 60);
  const minutes = totalMinutes % 60;

  return hours > 0 ? `${hours}h ${minutes}m` : `${minutes}m`;
}

function formatMods(mods) {
  const value = Number(mods) || 0;
  const names = MODS.filter(([bit]) => (value & bit) === bit).map(
    ([, name]) => name,
  );

  return names.length > 0 ? names.join("") : "NM";
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime())
    ? null
    : date.toLocaleString("en-US", {
        dateStyle: "medium",
        timeStyle: "short",
        timeZone: "UTC",
      });
}

function formatTimeAgo(value) {
  const timestamp = new Date(value).getTime();
  if (Number.isNaN(timestamp)) {
    return null;
  }

  const seconds = Math.round((timestamp - Date.now()) / 1000);
  const units = [
    ["year", 60 * 60 * 24 * 365],
    ["month", 60 * 60 * 24 * 30],
    ["day", 60 * 60 * 24],
    ["hour", 60 * 60],
    ["minute", 60],
  ];
  const formatter = new Intl.RelativeTimeFormat("en", { numeric: "auto" });

  for (const [unit, duration] of units) {
    if (Math.abs(seconds) >= duration) {
      return formatter.format(Math.round(seconds / duration), unit);
    }
  }

  return formatter.format(seconds, "second");
}

function formatJoinedDate(creationTime) {
  const timestamp = Number(creationTime);
  if (!Number.isFinite(timestamp) || timestamp <= 0) {
    return "Join date unavailable";
  }

  return new Date(timestamp * 1000).toLocaleDateString("en-US", {
    year: "numeric",
    month: "long",
  });
}

function getMapName(beatmap) {
  if (!beatmap) {
    return "Unknown beatmap";
  }

  return `${beatmap.artist} - ${beatmap.title} [${beatmap.version}]`;
}

function escapeMarkdown(value) {
  return value
    .replace(/([\\_*~`|])/g, "\\$1");
}

function createProfileEmbed(player, stats, mode) {
  const rank = stats.rank ? `#${formatNumber(stats.rank)}` : "Unranked";
  const countryRank = stats.country_rank
    ? `#${formatNumber(stats.country_rank)}`
    : "Unranked";
  const urls = getServerUrls();

  return new EmbedBuilder()
    .setColor(0xaaaaff)
    .setAuthor({
      name: player.name,
      url: urls.profile(player.id),
      iconURL: urls.avatar(player.id),
    })
    .setURL(urls.profile(player.id))
    .setDescription(
      [
        `Accuracy: **${getAccuracy(stats.acc)}**`,
        `Playcount: **${formatNumber(stats.plays)}** (${formatPlaytime(stats.playtime)})`,
        `Max combo: **${formatNumber(stats.max_combo)}x**`,
        `Grades: XH **${formatNumber(stats.xh_count)}** · X **${formatNumber(stats.x_count)}** · SH **${formatNumber(stats.sh_count)}** · S **${formatNumber(stats.s_count)}** · A **${formatNumber(stats.a_count)}**`,
      ].join("\n"),
    )
    .setThumbnail(urls.avatar(player.id))
    .addFields(
      {
        name: "Performance",
        value: `**${formatNumber(Math.round(stats.pp))}pp**\nGlobal: **${rank}** · Country: **${countryRank}**`,
        inline: true,
      },
      {
        name: "Score",
        value: `Ranked: **${formatNumber(stats.rscore)}**\nTotal: **${formatNumber(stats.tscore)}**`,
        inline: true,
      },
    )
    .setFooter({
      text: `Mode: ${getModeName(mode)} • Joined Inlayo's osu private server ${formatJoinedDate(player.creation_time)}`,
    });
}

function createScoreEmbed(player, score, mode, scope, index = 1) {
  const isRecent = scope === "recent";
  const urls = getServerUrls();
  const beatmap = score.beatmap;
  const pp = Number(score.pp);
  const scoreValue = Number(score.score);
  const mapName = getMapName(beatmap);
  const performance =
    Number.isFinite(pp) && pp > 0
      ? `${pp.toFixed(2)}pp`
      : `${formatNumber(scoreValue)} score`;
  const misses = Number(score.nmiss) || 0;
  const date = formatDate(score.play_time);

  const embed = new EmbedBuilder()
    .setColor(0xaaaaff)
    .setAuthor({
      name: player.name,
      url: urls.profile(player.id),
      ...(!isRecent && { iconURL: urls.avatar(player.id) }),
    })
    .setTitle(mapName.slice(0, 256))
    .setURL(beatmap ? urls.beatmap(beatmap.id) : urls.profile(player.id))
    .setFooter({
      text: `${isRecent ? `Recent score #${index}` : `Top score #${index}`} • ${getModeName(mode)}${date ? ` • ${date}` : ""}`,
    })
    .addFields(
      {
        name: "Performance",
        value: `${score.grade || "?"}${score.perfect ? " FC" : ""} · **${performance}**`,
        inline: true,
      },
      {
        name: "Accuracy",
        value: getAccuracy(score.acc),
        inline: true,
      },
      {
        name: "Combo",
        value: `[**${formatNumber(score.max_combo)}x**/${formatNumber(beatmap?.max_combo)}x]`,
        inline: true,
      },
      {
        name: "Misses",
        value: formatNumber(misses),
        inline: true,
      },
      {
        name: "Mods",
        value: formatMods(score.mods),
        inline: true,
      },
    );

  if (Number.isInteger(beatmap?.set_id) && beatmap.set_id > 0) {
    embed.setThumbnail(urls.beatmapThumbnail(beatmap.set_id));
  } else if (!isRecent) {
    embed.setThumbnail(urls.avatar(player.id));
  }

  return embed;
}

function createScoresEmbed(player, scores, mode, page, pageSize) {
  const urls = getServerUrls();
  const visibleScores = scores.slice(0, pageSize);
  const lines = visibleScores.map((score, index) => {
    const beatmap = score.beatmap;
    const mapName = getMapName(beatmap).slice(0, 180);
    const mapLink = beatmap
      ? `[${escapeMarkdown(mapName)}](${urls.beatmap(beatmap.id)})`
      : mapName;
    const pp = Number(score.pp);
    const scoreValue = Number(score.score);
    const performance =
      Number.isFinite(pp) && pp > 0
        ? `${pp.toFixed(2)}pp`
        : `${formatNumber(scoreValue)} score`;
    const misses = Number(score.nmiss) || 0;
    const number = page * pageSize + index + 1;
    const grade = `${score.grade || "?"}${score.perfect ? " FC" : ""}`;
    const maxCombo = formatNumber(beatmap?.max_combo);

    return [
      `**#${number} ${grade} ${mapLink}**`,
      `${performance} (${getAccuracy(score.acc)}) [**${formatNumber(score.max_combo)}x**/${maxCombo}x] x ${formatNumber(misses)}**+${formatMods(score.mods)}**`,
    ].join("\n");
  });
  const embed = new EmbedBuilder()
    .setColor(0xaaaaff)
    .setAuthor({
      name: player.name,
      url: urls.profile(player.id),
      iconURL: urls.avatar(player.id),
    })
    .setURL(urls.profile(player.id))
    .setDescription(
      lines.join("\n").slice(0, 4096),
    )
    .setFooter({
      text: `Page ${page + 1} • Mode: ${getModeName(mode)}`,
    });

  embed.setThumbnail(urls.avatar(player.id));

  return embed;
}

function createTopPaginationSession(player, mode, pageSize, ownerId) {
  if (!ownerId) {
    return null;
  }

  const now = Date.now();
  for (const [id, session] of topPaginationSessions) {
    if (session.expiresAt <= now) {
      topPaginationSessions.delete(id);
    }
  }

  const id = crypto.randomBytes(12).toString("hex");
  topPaginationSessions.set(id, {
    ownerId,
    player: { id: player.id, name: player.name },
    mode,
    page: 0,
    pageSize,
    hasNext: true,
    expiresAt: now + TOP_SESSION_TTL,
  });

  return id;
}

function createTopPaginationComponents(sessionId, page, hasNext) {
  if (!sessionId || (page === 0 && !hasNext)) {
    return [];
  }

  return [
    new ActionRowBuilder()
      .addComponents(
        new ButtonBuilder()
          .setCustomId(`${TOP_COMPONENT_PREFIX}:${sessionId}:prev`)
          .setLabel("Previous")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(page === 0),
        new ButtonBuilder()
          .setCustomId(`${TOP_COMPONENT_PREFIX}:${sessionId}:next`)
          .setLabel("Next")
          .setStyle(ButtonStyle.Secondary)
          .setDisabled(!hasNext),
      )
      .toJSON(),
  ];
}

function getTopPaginationSession(interaction) {
  const customId = interaction.data?.custom_id;
  if (typeof customId !== "string") {
    return { error: "This top-score page is invalid or has expired." };
  }

  const match = customId.match(/^osu_top:([a-f0-9]{24}):(prev|next)$/);
  if (!match) {
    return { error: "This top-score page is invalid or has expired." };
  }

  const session = topPaginationSessions.get(match[1]);
  if (!session || session.expiresAt <= Date.now()) {
    topPaginationSessions.delete(match[1]);
    return { error: "This top-score page has expired. Run the top command again." };
  }

  const userId = getDiscordUserId(interaction);
  if (userId !== session.ownerId) {
    return { error: "Only the user who requested these top scores can change pages." };
  }

  if (
    (match[2] === "prev" && session.page === 0) ||
    (match[2] === "next" && !session.hasNext)
  ) {
    return { error: "There are no more top-score pages in that direction." };
  }

  return { session, direction: match[2] };
}

function getPublicErrorMessage(error) {
  const status = error.response?.status;

  if (status === 404) {
    return "Player or mode statistics were not found on Inlayo's osu private server.";
  }
  if (status === 422) {
    return "This game mode is not supported on Inlayo's osu private server.";
  }
  if (error.code === "ECONNABORTED") {
    return "Inlayo's osu private server timed out. Please try again later.";
  }
  if (error.message === "INLAYO_API_BASE is not configured.") {
    return "The bot operator must configure INLAYO_API_BASE.";
  }
  if (error.code === "ERR_INVALID_URL") {
    return "The bot operator configured an invalid API URL for Inlayo's osu private server.";
  }
  if (error.response) {
    return "Inlayo's osu private server could not process the request. Please try again later.";
  }
  if (error.request) {
    return "Could not connect to Inlayo's osu private server. Please check the API URL and server status.";
  }

  return "An error occurred while processing the command.";
}

function isSupportedCommand(interaction) {
  return commandByName.has(interaction?.data?.name);
}

async function executeCommand(interaction) {
  const commandName = interaction.data.name;
  const spec = commandByName.get(commandName);
  const discordUserId = getDiscordUserId(interaction);
  const requestedUsername = getOption(interaction, "username");

  if (spec.type === "link") {
    if (!discordUserId) {
      return { content: "Your Discord account could not be identified." };
    }

    const player = await getPlayer(requestedUsername);
    saveLinkedAccount(discordUserId, player.name);
    return {
      content: `Linked your Discord account to **${player.name}** on Inlayo's osu private server. You can now use \`!t\` without a username.`,
    };
  }

  if (spec.type === "unlink") {
    if (!discordUserId) {
      return { content: "Your Discord account could not be identified." };
    }

    return {
      content: removeLinkedAccount(discordUserId)
        ? "Your account on Inlayo's osu private server has been unlinked."
        : "You do not have an account linked to Inlayo's osu private server.",
    };
  }

  const username =
    requestedUsername ?? getLinkedAccount(discordUserId);
  if (!username) {
    return {
      content:
        "Link your account on Inlayo's osu private server first with `!link <username>` or `/link`.",
    };
  }

  const mode = getOption(interaction, "mode") ?? spec.mode;
  const player = await getPlayer(username);

  if (spec.type === "profile") {
    const stats = await getPlayerModeStats(player.id, mode);

    return { embeds: [createProfileEmbed(player, stats, mode)] };
  }

  const scope = spec.type === "top" ? "best" : "recent";
  const index = getOption(interaction, "index");
  const pageSize =
    spec.type === "top" ? (getOption(interaction, "limit") ?? TOP_PAGE_SIZE) : 1;
  const limit =
    index !== undefined
      ? 1
      : spec.type === "top"
        ? pageSize + 1
        : 1;
  const offset = index === undefined ? 0 : index - 1;
  const scores = await getPlayerScores(
    player.id,
    mode,
    scope,
    limit,
    scope === "recent" && !spec.passes,
    offset,
  );

  if (scores.length === 0) {
    return {
      content:
        spec.type === "recent"
          ? `${player.name} has no recent plays on Inlayo's osu private server.`
          : `${player.name} has no top plays on Inlayo's osu private server.`,
    };
  }

  if (spec.type === "recent" || index !== undefined) {
    return {
      embeds: [
        createScoreEmbed(
          player,
          scores[0],
          mode,
          scope,
          index === undefined ? 1 : offset + 1,
        ),
      ],
    };
  }

  const hasNext = scores.length > pageSize;
  const sessionId = hasNext
    ? createTopPaginationSession(
        player,
        mode,
        pageSize,
        getDiscordUserId(interaction),
      )
    : null;

  return {
    embeds: [createScoresEmbed(player, scores, mode, 0, pageSize)],
    components: createTopPaginationComponents(sessionId, 0, hasNext),
  };
}

async function handleInteraction(interaction) {
  try {
    return await executeCommand(interaction);
  } catch (error) {
    if (error.response || error.request) {
      console.error("Inlayo osu! API request failed:", error.message);
    } else if (
      error.message !== "INLAYO_API_BASE is not configured." &&
      error.code !== "ERR_INVALID_URL"
    ) {
      console.error("Failed to handle Inlayo osu! command:", error);
    }

    return { content: getPublicErrorMessage(error) };
  }
}

function isSupportedComponent(interaction) {
  return interaction?.type === 3 &&
    typeof interaction.data?.custom_id === "string" &&
    interaction.data.custom_id.startsWith(`${TOP_COMPONENT_PREFIX}:`);
}

function getComponentError(interaction) {
  const result = getTopPaginationSession(interaction);
  return result.error ?? null;
}

async function handleComponentInteraction(interaction) {
  const result = getTopPaginationSession(interaction);
  if (result.error) {
    return { content: result.error, embeds: [], components: [] };
  }

  const { session, direction } = result;
  const page = session.page + (direction === "next" ? 1 : -1);
  try {
    const scores = await getPlayerScores(
      session.player.id,
      session.mode,
      "best",
      session.pageSize + 1,
      false,
      page * session.pageSize,
    );
    if (scores.length === 0) {
      return {
        content: "No more top scores are available on this page.",
        embeds: [],
        components: [],
      };
    }

    session.page = page;
    session.hasNext = scores.length > session.pageSize;
    session.expiresAt = Date.now() + TOP_SESSION_TTL;
    const sessionId = interaction.data.custom_id.split(":")[1];

    return {
      embeds: [
        createScoresEmbed(
          session.player,
          scores,
          session.mode,
          session.page,
          session.pageSize,
        ),
      ],
      components: createTopPaginationComponents(
        sessionId,
        session.page,
        session.hasNext,
      ),
    };
  } catch (error) {
    if (error.response || error.request) {
      console.error("Inlayo osu! API pagination request failed:", error.message);
    } else {
      console.error("Failed to handle Inlayo osu! top pagination:", error);
    }

    return {
      content: getPublicErrorMessage(error),
      embeds: [],
      components: [],
    };
  }
}

async function handleMessage(message) {
  if (message.author.bot || !message.guild) {
    return;
  }

  const match = message.content.match(/^!([^\s]+)(?:\s+([\s\S]*))?$/);
  if (!match) {
    return;
  }

  const commandToken = match[1].toLowerCase();
  let commandName = commandToken;
  let index;
  let spec = commandByName.get(commandName);
  if (!spec) {
    const indexedCommand = commandToken.match(/^(.+?)(\d+)$/);
    if (indexedCommand) {
      commandName = indexedCommand[1];
      index = Number(indexedCommand[2]);
      spec = commandByName.get(commandName);
    }
  }
  if (!spec) {
    return;
  }

  const args = (match[2] ?? "").trim().split(/\s+/).filter(Boolean);
  if (spec.type === "recent" && /^\d+$/.test(args[0] ?? "")) {
    index ??= Number(args.shift());
  }
  let mode;
  if (
    ["profile", "top", "recent"].includes(spec.type) &&
    args.length > 0
  ) {
    const requestedMode = MODE_TOKENS.get(args[args.length - 1].toLowerCase());
    if (requestedMode !== undefined) {
      mode = requestedMode;
      args.pop();
    }
  }
  if (index !== undefined && (!Number.isInteger(index) || index < 1 || index > 100)) {
    await message.reply("Score position must be between 1 and 100.");
    return;
  }
  const username = args.join(" ");
  if (
    (spec.type === "link" && !username) ||
    (spec.type !== "link" &&
      spec.type !== "unlink" &&
      !username &&
      !getLinkedAccount(message.author.id))
  ) {
    await message.reply(
      spec.type === "link"
        ? "Usage: `!link <username on Inlayo's osu private server>`"
        : "Link your account on Inlayo's osu private server first with `!link <username>` or `/link`.",
    );
    return;
  }

  const interaction = {
    user: { id: message.author.id },
    data: {
      name: commandName,
      options: [
        ...(username ? [{ name: "username", value: username }] : []),
        ...(mode !== undefined ? [{ name: "mode", value: mode }] : []),
        ...(index ? [{ name: "index", value: index }] : []),
      ],
    },
  };
  const payload = await handleInteraction(interaction);
  await message.reply(payload);
}

function isPrivateCommand(interaction) {
  const spec = commandByName.get(interaction?.data?.name);
  return spec?.type === "link" || spec?.type === "unlink";
}

async function registerCommands(applicationId, additionalCommands = []) {
  const rest = new REST({ version: "10" }).setToken(process.env.DISCORD_TOKEN);
  const guildId = process.env.DISCORD_GUILD_ID;
  const route = guildId
    ? Routes.applicationGuildCommands(applicationId, guildId)
    : Routes.applicationCommands(applicationId);

  await rest.put(route, { body: [...commands, ...additionalCommands] });
  console.log(
    `Registered Inlayo osu! slash commands${guildId ? ` for guild ${guildId}` : ""}.`,
  );
}

async function editOriginalResponse(interaction, payload) {
  await axios.patch(
    `https://discord.com/api/v10/webhooks/${interaction.application_id}/${interaction.token}/messages/@original`,
    payload,
    { timeout: API_TIMEOUT },
  );
}

module.exports = {
  getComponentError,
  handleComponentInteraction,
  editOriginalResponse,
  handleMessage,
  handleInteraction,
  isSupportedComponent,
  isSupportedCommand,
  isPrivateCommand,
  registerCommands,
};
