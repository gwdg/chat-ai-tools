// Best-effort human-like input and environment helpers.
// These reduce obvious automation fingerprints; they do not solve CAPTCHAs
// or defeat anti-bot systems.

export function randomBetween(min, max, random = Math.random) {
  return min + random() * (max - min);
}

export function randomInt(min, max, random = Math.random) {
  return Math.floor(randomBetween(min, max + 1, random));
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function platformToken(platform = process.platform) {
  if (platform === "darwin") return "Macintosh; Intel Mac OS X 10_15_7";
  if (platform === "win32") return "Windows NT 10.0; Win64; x64";
  return "X11; Linux x86_64";
}

export function chromeUserAgent(version, platform = process.platform) {
  const match = String(version || "").match(/(\d+\.\d+\.\d+\.\d+)/);
  const chromeVersion = match ? match[1] : "131.0.0.0";
  return `Mozilla/5.0 (${platformToken(platform)}) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/${chromeVersion} Safari/537.36`;
}

export function typingSchedule(
  text,
  {
    minDelay = 35,
    maxDelay = 110,
    pauseChance = 0.06,
    pauseMin = 120,
    pauseMax = 400,
    random = Math.random,
  } = {},
) {
  return [...String(text)].map(() => {
    let delay = randomBetween(minDelay, maxDelay, random);
    if (random() < pauseChance) {
      delay += randomBetween(pauseMin, pauseMax, random);
    }
    return Math.round(delay);
  });
}

export async function settle({ min = 120, max = 380, random = Math.random } = {}) {
  await sleep(randomBetween(min, max, random));
}

function mouseStateFor(states, page) {
  let state = states.get(page);
  if (!state) {
    const viewport = page.viewport() || { width: 1280, height: 900 };
    state = {
      position: {
        x: viewport.width / 2 + randomBetween(-40, 40),
        y: viewport.height / 2 + randomBetween(-30, 30),
      },
    };
    states.set(page, state);
  }
  return state;
}

export async function moveMouse(
  page,
  state,
  x,
  y,
  { random = Math.random } = {},
) {
  const from = state.position;
  const distance = Math.hypot(x - from.x, y - from.y);
  const steps = Math.max(10, Math.min(45, Math.round(distance / 22)));
  const controlX = (from.x + x) / 2 + randomBetween(-70, 70, random);
  const controlY = (from.y + y) / 2 + randomBetween(-70, 70, random);

  await page.mouse.move(controlX, controlY, {
    steps: Math.max(5, Math.round(steps / 2)),
  });
  await sleep(randomBetween(15, 55, random));
  await page.mouse.move(x, y, {
    steps: Math.max(5, Math.round(steps / 2)),
  });
  state.position = { x, y };
  await sleep(randomBetween(30, 90, random));
}

export async function humanClick(
  page,
  state,
  handle,
  { button = "left", clickCount = 1, random = Math.random } = {},
) {
  await handle.evaluate((el) =>
    el.scrollIntoView({ block: "center", inline: "center" }),
  );
  const box = await handle.boundingBox();

  if (!box || box.width <= 0 || box.height <= 0) {
    await handle.click({ button, clickCount });
    return;
  }

  const x = box.x + box.width * randomBetween(0.3, 0.7, random);
  const y = box.y + box.height * randomBetween(0.3, 0.7, random);
  await moveMouse(page, state, x, y, { random });
  await sleep(randomBetween(35, 120, random));
  await page.mouse.click(x, y, {
    button,
    clickCount,
    delay: Math.round(randomBetween(25, 85, random)),
  });
}

export async function humanType(
  page,
  text,
  { random = Math.random, ...scheduleOptions } = {},
) {
  const characters = [...String(text)];
  const delays = typingSchedule(text, { random, ...scheduleOptions });
  for (let index = 0; index < characters.length; index += 1) {
    await page.keyboard.type(characters[index]);
    await sleep(delays[index] ?? 60);
  }
}

export async function humanScroll(
  page,
  state,
  deltaY,
  { random = Math.random } = {},
) {
  const viewport = page.viewport() || { width: 1280, height: 900 };
  await moveMouse(
    page,
    state,
    viewport.width / 2 + randomBetween(-120, 120, random),
    viewport.height / 2 + randomBetween(-80, 80, random),
    { random },
  );

  const direction = Math.sign(deltaY) || 1;
  let remaining = Math.abs(deltaY);
  while (remaining > 0) {
    const chunk = Math.min(remaining, Math.round(randomBetween(70, 170, random)));
    await page.mouse.wheel({ deltaY: direction * chunk });
    remaining -= chunk;
    await sleep(randomBetween(25, 90, random));
  }
}

export { mouseStateFor };
