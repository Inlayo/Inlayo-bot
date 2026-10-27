require("dotenv").config();

const express = require("express");
const {
  verifyKeyMiddleware,
  InteractionType,
  InteractionResponseType,
} = require("discord-interactions");
const {
  Client,
  GatewayIntentBits,
  Partials,
  ActivityType,
} = require("discord.js");

const owoMaplinkEmbedDelete = require("./features/owo_maplink_embed_delete");
const twitchNotification = require("./features/twitch_notification");
const inlayoOsu = require("./features/inlayo_osu");

const PORT = Number(process.env.PORT) || 3000;
const { DISCORD_PUBLIC_KEY, DISCORD_TOKEN } = process.env;

for (const [name, value] of Object.entries({
  DISCORD_PUBLIC_KEY,
  DISCORD_TOKEN,
})) {
  if (!value) {
    console.error(`${name} is not configured.`);
    process.exit(1);
  }
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  partials: [Partials.Channel],
});

const app = express();

client.once("ready", async () => {
  console.log(`Bot logged in as ${client.user.tag}.`);
  console.log(`Bot ID: ${client.user.id}.`);

  client.user.setActivity("osu!", {
    type: ActivityType.Playing,
  });

  try {
    await inlayoOsu.registerCommands(
      client.user.id,
      twitchNotification.getSlashCommands(),
    );
  } catch (error) {
    console.error("Failed to register Inlayo's osu private server commands:", error);
  }

  try {
    await twitchNotification.initialize(client);
  } catch (error) {
    console.error("Failed to initialize Twitch notifications:", error);
  }
});

client.on("messageCreate", async (message) => {
  try {
    await inlayoOsu.handleMessage(message);
  } catch (error) {
    console.error("Failed to handle Inlayo's osu private server command:", error);
  }

  try {
    await owoMaplinkEmbedDelete.handleMessage(message);
  } catch (error) {
    console.error("Failed to handle osu! map link message:", error);
  }

  try {
    await twitchNotification.handleMessage(message);
  } catch (error) {
    console.error("Failed to handle Twitch notification message:", error);
  }
});

app.post(
  "/api/interactions",
  verifyKeyMiddleware(DISCORD_PUBLIC_KEY),
  (req, res) => {
    if (req.body?.type === InteractionType.PING) {
      return res.json({ type: InteractionResponseType.PONG });
    }

    if (req.body?.type === InteractionType.MESSAGE_COMPONENT) {
      if (!inlayoOsu.isSupportedComponent(req.body)) {
        return res.status(400).json({ error: "Unsupported interaction." });
      }

      const componentError = inlayoOsu.getComponentError(req.body);
      if (componentError) {
        return res.json({
          type: InteractionResponseType.CHANNEL_MESSAGE_WITH_SOURCE,
          data: { content: componentError, flags: 64 },
        });
      }

      res.json({
        type: InteractionResponseType.DEFERRED_UPDATE_MESSAGE,
      });

      void inlayoOsu
        .handleComponentInteraction(req.body)
        .then((payload) => inlayoOsu.editOriginalResponse(req.body, payload))
        .catch((error) => {
          console.error("Failed to update Inlayo top-score page:", error);
        });

      return;
    }

    if (req.body?.type !== InteractionType.APPLICATION_COMMAND) {
      return res.status(400).json({ error: "Unsupported interaction." });
    }

    const isTwitchCommand = twitchNotification.isSupportedCommand(req.body);
    if (!isTwitchCommand && !inlayoOsu.isSupportedCommand(req.body)) {
      return res.status(400).json({ error: "Unsupported interaction." });
    }

    res.json({
      type: InteractionResponseType.DEFERRED_CHANNEL_MESSAGE_WITH_SOURCE,
      ...(inlayoOsu.isPrivateCommand(req.body)
        ? { data: { flags: 64 } }
        : {}),
    });

    const handleInteraction = isTwitchCommand
      ? twitchNotification.handleInteraction
      : inlayoOsu.handleInteraction;

    void handleInteraction(req.body)
      .then((payload) => inlayoOsu.editOriginalResponse(req.body, payload))
      .catch((error) => {
        console.error(
          "Failed to send Inlayo's osu private server command response:",
          error,
        );
      });
  },
);

const server = app.listen(PORT, () => {
  console.log(`HTTP server listening on port ${PORT}.`);
});

async function shutdown(signal) {
  console.log(`Received ${signal}. Shutting down...`);

  twitchNotification.destroy();
  server.close();
  client.destroy();
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

client.login(DISCORD_TOKEN).catch((error) => {
  console.error("Failed to log in to Discord:", error);
  process.exit(1);
});
