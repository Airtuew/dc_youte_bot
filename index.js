import 'dotenv/config';
import express from 'express';
import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';

const TOKEN = process.env.DISCORD_TOKEN;
const CLIENT_ID = process.env.CLIENT_ID;
const GUILD_ID = process.env.GUILD_ID;
const PORT = process.env.PORT || 3000;

// --- Express keep-alive for Render ---
const app = express();
app.get('/', (req, res) => res.send('Bot is running.'));
app.listen(PORT, () => console.log(`🌐 Express listening on port ${PORT}`));

// --- Discord Client ---
const client = new Client({
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildMembers],
  partials: [Partials.Channel],
});

// --- Register slash commands ---
const commands = [
  new SlashCommandBuilder()
    .setName('setupbutton')
    .setDescription('建立身份組領取按鈕')
    .addStringOption(option =>
      option.setName('role')
        .setDescription('要領取的身份組名稱')
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
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'setupbutton') {
      const roleName = interaction.options.getString('role');
      const messageText = interaction.options.getString('message');

      // 檢查身份組是否存在，若不存在就創建
      let role = interaction.guild.roles.cache.find(r => r.name === roleName);
      if (!role) {
        try {
          role = await interaction.guild.roles.create({
            name: roleName,
            mentionable: true,
          });
          console.log(`創建身份組: ${roleName}`);
        } catch (err) {
          console.error('身份組創建失敗', err);
          return interaction.reply({ content: '❌ 無法創建身份組', ephemeral: true });
        }
      }

      // 建立按鈕
      const button = new ButtonBuilder()
        .setCustomId(`role_${role.id}`)
        .setLabel(`領取 ${role.name}`)
        .setStyle(ButtonStyle.Primary);

      const row = new ActionRowBuilder().addComponents(button);

      await interaction.reply({ content: messageText, components: [row] });
    }
  }

  // --- 按鈕點擊處理 ---
  if (interaction.isButton()) {
    const customId = interaction.customId;
    if (!customId.startsWith('role_')) return;

    const roleId = customId.replace('role_', '');
    const member = interaction.member;

    if (member.roles.cache.has(roleId)) {
      // 已有身份組 → 移除
      await member.roles.remove(roleId);
      return interaction.reply({ content: `❌ 已移除身份組`, ephemeral: true });
    } else {
      // 沒有身份組 → 加上
      await member.roles.add(roleId);
      return interaction.reply({ content: `✅ 已領取身份組`, ephemeral: true });
    }
  }
});

// --- Ready ---
client.once('ready', () => {
  console.log(`🤖 Logged in as ${client.user.tag}`);
  registerCommands();
});

client.login(TOKEN);