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
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  MessageFlags 
} = require('discord.js');
const puppeteer = require('puppeteer');

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

// Global State
let targetChannelId = null;
let baseUrl = null;
let currentPath = '/';
let liveMessage = null;
let errorAlertMessage = null;
let updateInterval = null;
let detectedPaths = [];

/**
 * Dynamically builds Discord ActionRows/Buttons based on scraped webpage paths.
 * Falls back to default paths (/admin, /feedback, /pricing) if no <a> tags are detected.
 */
function createDynamicButtons() {
  const components = [];
  
  const activePaths = detectedPaths.length > 0 
    ? detectedPaths 
    : ['/admin', '/feedback', '/pricing'];

  let currentButtons = [
    new ButtonBuilder()
      .setCustomId('nav_/')
      .setLabel('🏠 Home')
      .setStyle(currentPath === '/' ? ButtonStyle.Success : ButtonStyle.Primary)
  ];

  for (const path of activePaths) {
    const safePath = path.substring(0, 80); 
    const label = path.replace(/^\//, '').replace(/-/g, ' ') || 'Page';
    
    const btn = new ButtonBuilder()
      .setCustomId(`nav_${safePath}`)
      .setLabel(`🔗 ${label.charAt(0).toUpperCase() + label.slice(1)}`.substring(0, 80))
      .setStyle(currentPath === safePath ? ButtonStyle.Success : ButtonStyle.Secondary);
    
    currentButtons.push(btn);

    if (currentButtons.length === 5) {
      components.push(new ActionRowBuilder().addComponents(currentButtons));
      currentButtons = [];
    }
  }

  if (currentButtons.length > 0) {
    components.push(new ActionRowBuilder().addComponents(currentButtons));
  }

  return components;
}

// Slash Command Definitions
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
        .setDescription('Base URL (e.g., https://your-ngrok-url.ngrok-free.app)')
        .setRequired(true)
    ),
  new SlashCommandBuilder()
    .setName('page')
    .setDescription('Navigate to a specific subpath on the live site')
    .addStringOption(option =>
      option.setName('path')
        .setDescription('Subpath (e.g., /dashboard, /settings)')
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

// Handle Slash Commands and Button Interactions
client.on('interactionCreate', async (interaction) => {
  // 1. Slash Commands
  if (interaction.isChatInputCommand()) {
    const { commandName } = interaction;

    if (commandName === 'setchannel') {
      const channel = interaction.options.getChannel('channel');
      targetChannelId = channel.id;
      return interaction.reply({ 
        content: `✅ Target channel set to ${channel}`, 
        flags: MessageFlags.Ephemeral 
      });
    }

    if (commandName === 'stream') {
      let url = interaction.options.getString('url').trim();

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

      await interaction.deferReply({ flags: MessageFlags.Ephemeral });

      baseUrl = url.endsWith('/') ? url.slice(0, -1) : url;
      currentPath = '/';
      detectedPaths = [];

      const targetChannel = await client.channels.fetch(targetChannelId);

      const initialEmbed = new EmbedBuilder()
        .setTitle('🌐 StreamBot Dev - Live Feed')
        .setDescription(`Monitoring: \`${baseUrl}${currentPath}\``)
        .setColor(0x3498DB)
        .setFooter({ text: 'Initializing browser & scanning links...' });

      // Clean up previous messages if restarting
      if (liveMessage) try { await liveMessage.delete(); } catch {}
      if (errorAlertMessage) try { await errorAlertMessage.delete(); } catch {}

      liveMessage = await targetChannel.send({ embeds: [initialEmbed] });
      await interaction.editReply({ content: `🚀 Live feed initialized in ${targetChannel}!` });

      if (updateInterval) clearInterval(updateInterval);

      await updateFeed();
      updateInterval = setInterval(updateFeed, 10000);
    }

    if (commandName === 'page') {
      let path = interaction.options.getString('path').trim();
      if (!baseUrl) {
        return interaction.reply({ 
          content: '⚠️ No active stream running. Start one using `/stream`!', 
          flags: MessageFlags.Ephemeral 
        });
      }

      currentPath = path.startsWith('/') ? path : '/' + path;
      await interaction.reply({ 
        content: `🔄 Navigating to \`${currentPath}\`...`, 
        flags: MessageFlags.Ephemeral 
      });
      await updateFeed();
    }
  }

  // 2. Interactive Button Presses
  if (interaction.isButton()) {
    if (!baseUrl) {
      return interaction.reply({ 
        content: '⚠️ Stream session active session not found. Restart with `/stream`.', 
        flags: MessageFlags.Ephemeral 
      });
    }

    if (interaction.customId.startsWith('nav_')) {
      currentPath = interaction.customId.replace('nav_', '');
      
      await interaction.reply({ 
        content: `🔄 Loading \`${currentPath}\`...`, 
        flags: MessageFlags.Ephemeral 
      });
      
      await updateFeed();
    }
  }
});

/**
 * Renders the webpage via Puppeteer, extracts anchor tags, and updates the Discord embed.
 */
async function updateFeed() {
  if (!baseUrl || !liveMessage) return;

  const targetUrl = `${baseUrl}${currentPath}`;
  let browser;

  try {
    // Optimized Puppeteer launch arguments for container hosts (bot-hosting.net, Docker, etc.)
    browser = await puppeteer.launch({ 
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
        '--disable-gpu',
        '--remote-debugging-port=0'
      ],
      timeout: 60000
    });
    
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 720 });
    
    // Bypass Ngrok warning screen if using ngrok tunnel
    await page.setExtraHTTPHeaders({ 'ngrok-skip-browser-warning': 'true' });
    page.setDefaultNavigationTimeout(15000);

    // Fast DOM load wait
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    await new Promise(resolve => setTimeout(resolve, 1000));

    // Scrape valid internal <a> links on the current DOM
    const scrapedPaths = await page.evaluate(() => {
      return Array.from(document.querySelectorAll('a'))
        .map(a => a.pathname)
        .filter(p => p && p !== '/' && !p.startsWith('#'));
    });

    detectedPaths = [...new Set(scrapedPaths)].slice(0, 9);

    const screenshotBuffer = await page.screenshot({ type: 'png' });
    await browser.close();

    // If site restored, remove error message
    if (errorAlertMessage) {
      try { await errorAlertMessage.delete(); } catch {}
      errorAlertMessage = null;
    }

    const attachment = new AttachmentBuilder(screenshotBuffer, { name: 'preview.png' });

    const updatedEmbed = new EmbedBuilder()
      .setTitle('🌐 StreamBot Dev - Live Feed')
      .setDescription(`Current View: [${targetUrl}](${targetUrl})`)
      .setColor(0x2ECC71)
      .setImage('attachment://preview.png')
      .setFooter({ text: `Auto-refreshed at ${new Date().toLocaleTimeString()} | Path: ${currentPath}` });

    await liveMessage.edit({
      embeds: [updatedEmbed],
      files: [attachment],
      components: createDynamicButtons()
    });

  } catch (error) {
    console.error(`[Error loading ${targetUrl}]:`, error.message);
    if (browser) await browser.close();

    // Post connection error alert without destroying the last good snapshot
    if (targetChannelId && !errorAlertMessage) {
      const channel = await client.channels.fetch(targetChannelId);
      const errorEmbed = new EmbedBuilder()
        .setTitle('⚠️ Stream Connection Error')
        .setDescription(`Could not reach \`${targetUrl}\`.\n\n*Displaying last known working screenshot above.*`)
        .setColor(0xE74C3C)
        .setTimestamp();

      errorAlertMessage = await channel.send({ embeds: [errorEmbed] });
    }
  }
}

client.login(process.env.DISCORD_TOKEN);
