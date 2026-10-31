// 合成端点自检（synthetic）里两段探针（docs/specs/model-providers.md §7.8、§14.1 的 2026-10-31 补）的部分：图片探针与
// -vision、-slowtier、-slowfirst、关键词 wait-first-NNN。由 selfcheck.mjs 调用，用它的 chat、chatLogged、record、user。

/** 图片探针的提示（kernel/probes.ts 的 PROBE_PROMPTS.image） */
const IMAGE = 'What color is this image? Answer with one word.';
/** 一张图片（只要有 image_url 部分，端点不看内容） */
const IMAGE_URL = 'data:image/png;base64,iVBORw0KGgo=';
/** 第 6 步（后台一段）与第 3 步（必需一段）的提示 */
const JSON_PROMPT = 'Reply with JSON whose outcome is banana.';
const WEATHER = 'Use the tool to get the weather for Paris for the next 3 days.';
const weatherTool = { type: 'function', function: { name: 'get_weather', parameters: { type: 'object' } } };

/** @brief 带一张图片的图片探针请求体（OpenAI 兼容的写法，同 pi-ai 发出的样子）。 */
function imageBody(model) {
  return { model, messages: [{ role: 'user', content: [{ type: 'text', text: IMAGE },
    { type: 'image_url', image_url: { url: IMAGE_URL } }] }] };
}

/** @brief 一个回复从发出到第一个分块的毫秒数。 */
const firstMs = (out) => out.firstAt - out.startedAt;

/**
 * @brief 图片探针与 -vision：带图片的请求认作探针（日志 probe 为真），-vision 回 "Red."，其他回 "I can’t see any image."。
 * @param kit selfcheck.mjs 的 chat、chatLogged、record
 * @param f 不查 key 的端点
 */
async function checkVision({ chatLogged, record }, f) {
  const plain = await chatLogged(f, imageBody('fake-coder'));
  const vision = await chatLogged(f, imageBody('fake-coder-vision'));
  record('MP-44 image probe: a user message with an image and "What color is this image?" is a probe; -vision answers '
    + '"Red.", other models "I can’t see any image."', plain.log.probe === true && vision.log.probe === true
    && vision.out.text === 'Red.' && plain.out.text === 'I can’t see any image.',
  `${plain.out.text} / ${vision.out.text} / ${plain.log.probe} ${vision.log.probe}`);
}

/**
 * @brief -slowtier、-slowfirst 与 wait-first-NNN：回响应头之前多等。
 * @param s 设了 FAKE_SLOW_TIER_MS、FAKE_FIRST_TOKEN_MS（都是 400 毫秒）的端点
 */
async function checkDelays({ chat, record, user }, s) {
  const tier = await chat(s.port, { model: 'fake-coder-slowtier', messages: [user(JSON_PROMPT)] });
  const tierImage = await chat(s.port, imageBody('fake-coder-slowtier'));
  const essential = await chat(s.port, { model: 'fake-coder-slowtier', messages: [user(WEATHER)],
    tools: [weatherTool] });
  record('MP-42 -slowtier: background probes (step 6, the image probe) wait FAKE_SLOW_TIER_MS before answering; an '
    + 'essential probe (step 3) does not', firstMs(tier) >= 400 && firstMs(tierImage) >= 400
    && firstMs(essential) < 400 && essential.calls[0]?.name === 'get_weather',
  `${firstMs(tier)} ${firstMs(tierImage)} ${firstMs(essential)}`);
  const slow = await chat(s.port, { model: 'fake-coder-slowfirst', messages: [user(WEATHER)], tools: [weatherTool] });
  const talk = await chat(s.port, { model: 'fake-coder-slowfirst', messages: [user('plain')] });
  record('MP-45 -slowfirst: every probe request waits FAKE_FIRST_TOKEN_MS; a non-probe request does not',
    firstMs(slow) >= 400 && slow.calls[0]?.name === 'get_weather' && firstMs(talk) < 400,
    `${firstMs(slow)} ${firstMs(talk)}`);
  const waited = await chat(s.port, { messages: [user('wait-first-1 plain')] });
  const plain = await chat(s.port, { messages: [user('plain')] });
  record('MP-46 wait-first-NNN: the request waits NNN seconds before its response headers; without it no wait',
    firstMs(waited) >= 1000 && waited.status === 200 && firstMs(plain) < 1000, `${firstMs(waited)} ${firstMs(plain)}`);
}

/**
 * @brief 两段探针（§7.8）的全部自检。
 * @param kit selfcheck.mjs 的 chat、chatLogged、record、user
 * @param endpoints f：不查 key 的端点；s：设了两个延迟的端点
 */
export async function roundsChecks(kit, { f, s }) {
  await checkVision(kit, f);
  await checkDelays(kit, s);
}
