import '@std/dotenv/load';
import { basename, extname } from '@std/path';
import { ChannelTypes, createBot, FileContent, Intents, startBot } from 'https://deno.land/x/discordeno@18.0.1/mod.ts';
import { searchDisclosure } from './disclosure.ts';

const TOKEN_ENV_KEY = 'BOT_TOKEN';
const KV_KEY = ['TDnet', 'biz-alliance', 'lastTime'] as const;

(() => {
  if (!Deno.env.has(TOKEN_ENV_KEY)) {
    console.error(`Environment variable '${TOKEN_ENV_KEY}' is not set`);
    Deno.exit(1);
  }

  const bot = createBot({
    token: Deno.env.get(TOKEN_ENV_KEY)!,
    intents: Intents.Guilds | Intents.GuildMessages,
  });

  const getTextChannelIds = async (guildIds: bigint[]) => {
    const channelCollections = await Promise.all(guildIds.map((guildId) => bot.helpers.getChannels(guildId)));
    const channels = channelCollections.flatMap((collection) => [...collection.values()]);
    return channels
      .filter((chan) => chan.type === ChannelTypes.GuildText && chan.name === '一般')
      .map((chan) => chan.id);
  };

  const getFileContent = async (url: string): Promise<FileContent | undefined> => {
    const res = await fetch(url, {
      signal: AbortSignal.timeout(15000),
    });
    if (!res.ok) {
      return undefined;
    }
    const data = await res.blob();
    const fileName = basename(url);
    if (!data.type.includes('application/pdf')) {
      return {
        blob: data,
        name: fileName,
      };
    }
    const cmd = new Deno.Command('pdftoppm', {
      args: [
        '-png',
        '-',
      ],
      stdin: 'piped',
      stdout: 'piped',
      stderr: 'piped',
    });
    const process = cmd.spawn();
    const w = process.stdin.getWriter();
    w.write(await data.bytes());
    w.releaseLock();
    await process.stdin.close();
    const { code, stdout, stderr } = await process.output();
    if (code !== 0) {
      console.error(new TextDecoder().decode(stderr));
      return {
        blob: data,
        name: fileName,
      };
    }
    return {
      blob: new Blob([stdout], { type: 'image/png' }),
      name: fileName.replace(new RegExp(`${extname(fileName)}$`), '.png'),
    };
  };

  const main = async (channelIds: bigint[]) => {
    const kv = await Deno.openKv();
    // await kv.delete(KV_KEY);
    const lastTime = (await kv.get<number>(KV_KEY)).value ?? 0;
    const disclosure = await searchDisclosure(lastTime, ['提携', '協業']);
    if (disclosure.latestEntryTime > 0) {
      await kv.set(KV_KEY, disclosure.latestEntryTime);
    }
    if (disclosure.entries.length < 1) {
      console.log('No new entry about business alliances');
      return;
    }
    console.log(JSON.stringify(disclosure));
    for (const entry of disclosure.entries) {
      const content = `【${entry.companyName} (${entry.stockCode})】${entry.title} (${entry.time})\n${entry.url}`;
      for (const channelId of channelIds) {
        await bot.helpers.sendMessage(channelId, {
          content,
          file: await getFileContent(entry.url),
        });
      }
    }
  };

  new Promise<bigint[]>((resolve) => {
    bot.events.ready = (_, payload) => {
      console.log(`Logged in as ${payload.user.username}`);
      resolve(payload.guilds);
    };
    startBot(bot);
  }).then(async (guildIds) => {
    const channelIds = await getTextChannelIds(guildIds);
    Deno.cron('Fetch disclosures', {
      minute: { every: 1 },
    }, async () => {
      await new Promise((resolve) => setTimeout(resolve, 5000));
      main(channelIds);
    });
  }).catch((err) => {
    console.error(err);
    Deno.exit(1);
  });
})();
