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
    await twitchNotification.initialize(client);
  } catch (error) {
    console.error("Failed to initialize Twitch notifications:", error);
  }
});

client.on("messageCreate", async (message) => {
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

    return res.status(200).json({
      type: InteractionResponseType.PONG,
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
