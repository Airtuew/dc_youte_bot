import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const PORT = process.env.PORT || 3000;

// --- Express keep-alive ---
const app = express();
app.get('/', (req, res) => res.send('Bot is running.'));
app.listen(PORT, () => console.log(`🌐 Express listening on port ${PORT}`));

// --- Discord Client ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

// --- Slash commands ---
const commands = [
  new SlashCommandBuilder()
    .setName('setupbuttons')
    .setDescription('一次建立多個身份組按鈕')
    .addStringOption(option =>
      option.setName('roles')
        .setDescription('用逗號分隔身份組名稱，例如: 遊戲,音樂,程式')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('message')
        .setDescription('按鈕訊息')
        .setRequired(true)),
].map(cmd => cmd.toJSON());

const rest = new REST({ version: '10' }).setToken(TOKEN);

async function registerCommands() {
  try {
    await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commands }
    );
    console.log('✔ Slash 指令已註冊');
  } catch (err) {
    console.error(err);
  }
}

// --- Interaction Handler ---
client.on('interactionCreate', async interaction => {
  try {
    // ---- Slash Command ----
    if (interaction.isChatInputCommand()) {
      const { commandName } = interaction;

      if (commandName === 'setupbuttons') {
        const rolesInput = interaction.options.getString('roles');
        const messageText = interaction.options.getString('message');

        const roleNames = rolesInput.split(',').map(r => r.trim());
        const row = new ActionRowBuilder();

        for (let roleName of roleNames) {
          let role = interaction.guild.roles.cache.find(r => r.name === roleName);
          if (!role) {
            role = await interaction.guild.roles.create({
              name: roleName,
              mentionable: true,
            });
            console.log(`創建身份組: ${roleName}`);
          }

          const button = new ButtonBuilder()
            .setCustomId(`role_${role.id}`)
            .setLabel(role.name)
            .setStyle(ButtonStyle.Primary);

          row.addComponents(button);
        }

        await interaction.reply({ content: messageText, components: [row] });
      }
    }

    // ---- Button Interaction ----
    if (interaction.isButton()) {
      const customId = interaction.customId;
      if (!customId.startsWith('role_')) return;

      const roleId = customId.replace('role_', '');
      const member = interaction.member;

      if (member.roles.cache.has(roleId)) {
        await member.roles.remove(roleId);
        return interaction.reply({ content: `❌ 已移除身份組`, ephemeral: true });
      } else {
        await member.roles.add(roleId);
        return interaction.reply({ content: `✅ 已領取身份組`, ephemeral: true });
      }
    }
  } catch (err) {
    console.error('指令/按鈕處理錯誤', err);
    if (interaction.replied || interaction.deferred) {
      await interaction.editReply({ content: '⚠️ 發生錯誤', ephemeral: true }).catch(() => {});
    } else {
      await interaction.reply({ content: '⚠️ 發生錯誤', ephemeral: true }).catch(() => {});
    }
  }
});

// --- Ready ---
client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  registerCommands();
});

client.login(TOKEN);