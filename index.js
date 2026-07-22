require('dotenv').config();
const { 
  Client, 
  GatewayIntentBits, 
  REST, 
  Routes, 
  SlashCommandBuilder, 
  ChannelType, 
  EmbedBuilder, 
  AttachmentBuilder,
  MessageFlags // <-- Imported MessageFlags
} = require('discord.js');
const puppeteer = require('puppeteer');

const client = new Client({
  intents: [GatewayIntentBits.Guilds]
});

let targetChannelId = null;
let currentUrl = null;
let liveMessage = null;
let updateInterval = null;

// Define Slash Commands
const commands = [
  new SlashCommandBuilder()
    .setName('setchannel')
    .setDescription('Set the target channel for web monitoring status updates')
    .addChannelOption(option =>
      option.setName('channel')
        .setDescription('Select the target channel')
        .addChannelTypes(ChannelType.GuildVoice, ChannelType.GuildStageVoice, ChannelType.GuildText)
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('stream')
    .setDescription('Start monitoring a webpage live feed')
    .addStringOption(option =>
      option.setName('url')
        .setDescription('The website URL (e.g., https://example.com)')
        .setRequired(true)
    )
];

client.once('ready', async () => {
  console.log(`✅ StreamBot Dev online as ${client.user.tag}`);

  const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);
  try {
    console.log('Registering slash commands...');
    await rest.put(
      Routes.applicationCommands(client.user.id),
      { body: commands }
    );
    console.log('✅ Slash commands registered globally!');
  } catch (error) {
    console.error('Error registering commands:', error);
  }
});

client.on('interactionCreate', async (interaction) => {
  if (!interaction.isChatInputCommand()) return;

  const { commandName } = interaction;

  if (commandName === 'setchannel') {
    const channel = interaction.options.getChannel('channel');
    targetChannelId = channel.id;
    // Updated to use MessageFlags.Ephemeral
    await interaction.reply({ 
      content: `✅ Target channel set to ${channel}`, 
      flags: MessageFlags.Ephemeral 
    });
  }

  if (commandName === 'stream') {
    const url = interaction.options.getString('url');

    if (!targetChannelId) {
      return interaction.reply({ 
        content: '⚠️ Please set a target channel first using `/setchannel`!', 
        flags: MessageFlags.Ephemeral 
      });
    }

    if (!url.startsWith('http://') && !url.startsWith('https://')) {
      return interaction.reply({ 
        content: '❌ URL must start with `http://` or `https://`', 
        flags: MessageFlags.Ephemeral 
      });
    }

    // Updated deferReply to use MessageFlags.Ephemeral
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    currentUrl = url;
    const targetChannel = await client.channels.fetch(targetChannelId);

    const initialEmbed = new EmbedBuilder()
      .setTitle('🌐 Live Webpage Feed')
      .setDescription(`Monitoring: \`${currentUrl}\``)
      .setColor(0x3498DB)
      .setFooter({ text: 'Initializing browser preview...' });

    liveMessage = await targetChannel.send({ embeds: [initialEmbed] });
    await interaction.editReply({ content: `🚀 Live feed initialized in ${targetChannel}!` });

    if (updateInterval) clearInterval(updateInterval);

    await updateFeed();
    updateInterval = setInterval(updateFeed, 10000);
  }
});

async function updateFeed() {
  if (!currentUrl || !liveMessage) return;

  let browser;
  try {
    browser = await puppeteer.launch({ 
      headless: 'new',
      args: ['--no-sandbox', '--disable-setuid-sandbox'] 
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    await page.goto(currentUrl, { waitUntil: 'networkidle2', timeout: 30000 });

    const screenshotBuffer = await page.screenshot({ type: 'png' });
    await browser.close();

    const attachment = new AttachmentBuilder(screenshotBuffer, { name: 'preview.png' });

    const updatedEmbed = new EmbedBuilder()
      .setTitle('🌐 Live Webpage Feed')
      .setDescription(`Monitoring: [${currentUrl}](${currentUrl})`)
      .setColor(0x2ECC71)
      .setImage('attachment://preview.png')
      .setFooter({ text: `Last updated at ${new Date().toLocaleTimeString()}` });

    await liveMessage.edit({
      embeds: [updatedEmbed],
      files: [attachment]
    });

  } catch (error) {
    console.error('Error updating live feed:', error.message);
    if (browser) await browser.close();
  }
}

client.login(process.env.DISCORD_TOKEN);