// 完整可運作 Discord 語音機器人 (Render 可用) // Node.js 版本需 >= 18 // 安裝套件： // npm install discord.js@14 @discordjs/voice @discordjs/opus ffmpeg-static dotenv

import 'dotenv/config'; import { Client, GatewayIntentBits, Partials, REST, Routes, SlashCommandBuilder, EmbedBuilder, PermissionsBitField, } from 'discord.js';

import { joinVoiceChannel, createAudioPlayer, createAudioResource, NoSubscriberBehavior, getVoiceConnection, } from '@discordjs/voice';

import ffmpeg from 'ffmpeg-static'; import path from 'node:path'; import { fileURLToPath } from 'node:url';

const __filename = fileURLToPath(import.meta.url); const __dirname = path.dirname(__filename);

const TOKEN = process.env.DISCORD_TOKEN;

// ------------------------- // 建立 Client // ------------------------- const client = new Client({ intents: [ GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates ], partials: [Partials.Channel] });

// ------------------------- // 建立 Slash 指令 // ------------------------- const commands = [ new SlashCommandBuilder() .setName('join') .setDescription('讓機器人加入您所在的語音頻道'), new SlashCommandBuilder() .setName('leave') .setDescription('讓機器人離開語音頻道'), new SlashCommandBuilder() .setName('play') .setDescription('播放固定音效') ];

const rest = new REST({ version: '10' }).setToken(TOKEN);

async function registerCommands() { await rest.put(Routes.applicationCommands(process.env.CLIENT_ID), { body: commands.map(cmd => cmd.toJSON()), }); console.log('Slash 指令已重新整理'); }

// ------------------------- // 加入語音功能 // ------------------------- async function connectAndPlay(voiceChannel) { try { const connection = joinVoiceChannel({ channelId: voiceChannel.id, guildId: voiceChannel.guild.id, adapterCreator: voiceChannel.guild.voiceAdapterCreator, });

const player = createAudioPlayer({
  behaviors: { noSubscriber: NoSubscriberBehavior.Pause }
});

const audioPath = path.join(__dirname, 'sound.mp3');
const resource = createAudioResource(audioPath);
player.play(resource);

connection.subscribe(player);

console.log('已成功加入語音並播放音效');

} catch (err) { console.error('加入語音失敗：', err); throw new Error('無法加入語音頻道，請確認權限與頻道可用性'); } }

// ------------------------- // Bot Ready // ------------------------- client.once('ready', () => { console.log(已登入：${client.user.tag}); });

// ------------------------- // Slash 指令處理 // ------------------------- client.on('interactionCreate', async interaction => { if (!interaction.isChatInputCommand()) return;

try { const { commandName } = interaction;

if (commandName === 'join') {
  const channel = interaction.member.voice.channel;

  if (!channel)
    return interaction.reply({ content: '❌ 你必須先加入語音頻道才能使用！', ephemeral: true });

  await connectAndPlay(channel);
  return interaction.reply({ content: '✅ 已加入語音頻道', ephemeral: true });
}

if (commandName === 'leave') {
  const connection = getVoiceConnection(interaction.guild.id);

  if (!connection)
    return interaction.reply({ content: '❌ 機器人不在語音頻道內', ephemeral: true });

  connection.destroy();
  return interaction.reply({ content: '👋 已離開語音頻道', ephemeral: true });
}

if (commandName === 'play') {
  const connection = getVoiceConnection(interaction.guild.id);

  if (!connection)
    return interaction.reply({ content: '❌ 請先使用 /join 讓機器人加入語音', ephemeral: true });

  const player = createAudioPlayer();
  const audioPath = path.join(__dirname, 'sound.mp3');
  const resource = createAudioResource(audioPath);
  player.play(resource);
  connection.subscribe(player);

  return interaction.reply({ content: '🎵 開始播放音效！', ephemeral: true });
}

} catch (err) { console.error('指令處理錯誤：', err); return interaction.reply({ content: '⚠️ 指令處理失敗', ephemeral: true }); } });

// ------------------------- // 啟動 // ------------------------- registerCommands().then(() => client.login(TOKEN));