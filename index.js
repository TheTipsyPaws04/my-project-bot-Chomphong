require("dotenv").config();
const {
  Client,
  GatewayIntentBits,
  PermissionFlagsBits,
  ChannelType,
} = require("discord.js");
const config = require("./config");

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
});

// ============ State ============
const messageCounts = new Map();
const lastMessages = new Map();

function keyFor(guildId, userId) {
  return `${guildId}:${userId}`;
}

function resetUser(guildId, userId) {
  messageCounts.delete(keyFor(guildId, userId));
}

function isStaff(member) {
  if (!member) return false;
  if (
    member.permissions.has(PermissionFlagsBits.Administrator) ||
    member.permissions.has(PermissionFlagsBits.ManageGuild)
  )
    return true;
  if (config.staffRoleIds.length) {
    return member.roles.cache.some((r) => config.staffRoleIds.includes(r.id));
  }
  return false;
}

// ============ ตรวจลิงก์มัลแวร์/แสปม ============
function extractHostname(raw) {
  try {
    return new URL(raw).hostname.toLowerCase();
  } catch {
    return raw
      .replace(/^https?:\/\//i, "")
      .split(/[/?#:]/)[0]
      .toLowerCase();
  }
}

function isMalwareUrl(content) {
  const urls =
    content.match(/https?:\/\/[^\s<>"'{}]+/gi) ||
    content.match(/www\.[^\s<>"'{}]+/gi);
  if (!urls) return false;

  const blocked = config.malwareDomains.map((d) =>
    d.toLowerCase().replace(/^\./, "")
  );
  for (const url of urls) {
    const host = extractHostname(url);
    if (blocked.some((dom) => host === dom || host.endsWith(`.${dom}`)))
      return true;
  }
  return false;
}

// ============ Mute ============
async function ensureMuteRole(guild) {
  let role = guild.roles.cache.find((r) => r.name === "Anti-Spam Mute");
  if (!role) {
    try {
      role = await guild.roles.create({
        name: "Anti-Spam Mute",
        permissions: [],
      });
    } catch {
      return null;
    }
  }
  return role;
}

async function muteUser(member, guild, duration = config.muteDuration) {
  const timeoutSeconds = duration / 1000;
  const me = guild.members.me;

  if (me.permissions.has(PermissionFlagsBits.ModerateMembers)) {
    await member.timeout(duration, "ลงโทษแสปม");
    return timeoutSeconds;
  }

  const muteRole = await ensureMuteRole(guild);
  if (!muteRole)
    throw new Error("ไม่สามารถสร้าง role mute ได้ (ต้องการ Manage Roles)");
  await member.roles.add(muteRole);
  setTimeout(async () => {
    await member.roles.remove(muteRole).catch(() => {});
  }, duration);
  return timeoutSeconds;
}

// ลบข้อความแสปมของผู้ใช้เฉพาะในช่องธรรมดา
// ข้าม thread / โพสต์ฟอรั่ม / คอมเมนต์ใต้โพส (โซน "โพส") ไม่ลบ
async function purgeUserMessages(guild, userId) {
  const oldestAllowed = Date.now() - config.purgeWindowHours * 60 * 60 * 1000;
  const allowedTypes = [ChannelType.GuildText, ChannelType.GuildAnnouncement];

  const results = await Promise.all(
    Array.from(guild.channels.cache.values(), async (channel) => {
      if (!allowedTypes.includes(channel.type)) return 0;
      if (!channel.isTextBased()) return 0;
      if (!channel.viewable) return 0;
      if (!channel.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.ManageMessages)) return 0;
      try {
        const messages = await channel.messages.fetch({ limit: config.purgePerChannel });
        const toDelete = messages.filter(
          (m) =>
            m.author.id === userId &&
            m.createdTimestamp >= oldestAllowed &&
            m.deletable
        );
        if (toDelete.size > 0) {
          await channel.bulkDelete(toDelete, true);
          return toDelete.size;
        }
      } catch {}
      return 0;
    })
  );

  return results.reduce((sum, n) => sum + n, 0);
}

// ไล่ลบข้อความเก่าของผู้ต้องสงสัยแบบ background (ไม่บล็อกคำสั่ง mute/ban)
function purgeInBackground(guild, userId, reason) {
  purgeUserMessages(guild, userId)
    .then((n) => {
      if (n > 0)
        console.log(`🧹 ลบข้อความของ ${userId} แล้ว ${n} ชิ้น (${reason})`);
    })
    .catch(() => {});
}

// ============ Events ============
client.once("ready", () => {
  console.log(`✅ Bot กันแสปมพร้อมใช้งาน: ${client.user.tag}`);
  console.log(`🌍 เซิร์ฟเวอร์: ${client.guilds.cache.map((g) => g.name).join(", ")}`);
  client.guilds.cache.forEach((g) => {
    const channels = g.channels.cache
      .filter((c) => c.type === 0)
      .map((c) => `${c.name} (#${c.id})`);
    console.log(`📂 ${g.name}: ${channels.join(", ")}`);
  });
  client.user.setActivity("กันแสปม", { type: 3 });

  // ไล่ลบข้อความแจ้งเตือนเก่าที่บอทเคยส่งทิ้งไว้ (หลังบ้าน หลังบูต 10 วินาที)
  setTimeout(() => {
    client.guilds.cache.forEach((g) => {
      purgeInBackground(g, client.user.id, "ข้อความแจ้งเตือนเก่าของบอท");
    });
  }, 10000);
});

client.on("messageCreate", async (message) => {
  if (message.author.bot) return;
  if (!message.guild) return;

  const member =
    message.member ??
    (await message.guild.members
      .fetch(message.author.id)
      .catch(() => null));
  if (!member) return;

  if (isStaff(member)) return;

  // ห้ามพิมพ์ในช่อง bannedChannels → ลบ + แบนถาวร
  if (config.bannedChannels.includes(message.channel.id)) {
    return handleBannedChannel(message);
  }

  // ลิงก์มัลแวร์/แสปม → ลบ + mute ในทุกช่อง
  if (config.malwareDomains.length && isMalwareUrl(message.content)) {
    return handleMalwareUrl(message);
  }

  const key = keyFor(message.guild.id, message.author.id);
  const now = Date.now();

  // ข้อความซ้ำ
  const prev = lastMessages.get(key);
  if (prev && prev.content === message.content && now - prev.timestamp < config.duplicateWindow) {
    handleSpam(message, "ส่งข้อความซ้ำกัน");
    return;
  }
  lastMessages.set(key, { content: message.content, timestamp: now });

  // ข้อความยาวเกิน
  if (message.content.length > config.maxMessageLength) {
    handleSpam(message, "ข้อความยาวเกินกำหนด");
    return;
  }

  // จำนวนข้อความถี่เกิน
  const entry = messageCounts.get(key) || { count: 0, first: now };
  if (now - entry.first < config.rateWindow) {
    entry.count++;
    if (entry.count >= config.maxMessages) {
      handleSpam(message, "ส่งข้อความถี่เกินไป");
      return;
    }
    if (!entry.timer) {
      entry.timer = setTimeout(
        () => resetUser(message.guild.id, message.author.id),
        config.rateWindow + 1000
      );
    }
    messageCounts.set(key, entry);
  } else {
    clearTimeout(entry.timer);
    messageCounts.set(key, {
      count: 1,
      first: now,
      timer: setTimeout(
        () => resetUser(message.guild.id, message.author.id),
        config.rateWindow + 1000
      ),
    });
  }
});

// ============ Handlers ============
async function handleBannedChannel(message) {
  try {
    await message.delete();
  } catch {}
  try {
    await message.member.ban({
      reason: "พิมพ์ข้อความใน channel ต้องห้าม",
    });
    purgeInBackground(message.guild, message.author.id, "channel ต้องห้าม");
    console.log(`🔨 แบน: ${message.author.tag} (channel ต้องห้าม) ทำงานหลังบ้านสำเร็จ`);
  } catch (err) {
    console.error("Ban error:", err);
  }
}

async function handleSpam(message, reason) {
  const key = keyFor(message.guild.id, message.author.id);
  resetUser(message.guild.id, message.author.id);
  lastMessages.delete(key);

  try {
    // ลบเฉพาะข้อความแสปมชิ้นนี้
    await message.delete();
  } catch {}

  try {
    const timeoutSeconds = await muteUser(message.member, message.guild);
    purgeInBackground(message.guild, message.author.id, reason);
    console.log(`⛔ mute ${message.author.tag} เป็นเวลา ${timeoutSeconds / 60} นาที (${reason}) ทำงานหลังบ้านสำเร็จ`);
  } catch (err) {
    console.error("Anti-spam error:", err);
  }
}

async function handleMalwareUrl(message) {
  try {
    await message.delete();
  } catch {}

  try {
    await message.member.ban({
      reason: "ส่งลิงก์มัลแวร์/แสปม",
    });
    purgeInBackground(message.guild, message.author.id, "ลิงก์มัลแวร์");
    console.log(`🚫 แบน: ${message.author.tag} (ลิงก์มัลแวร์) ทำงานหลังบ้านสำเร็จ`);
  } catch (err) {
    console.error("Malware handler error:", err);
  }
}

client.login(process.env.DISCORD_TOKEN);