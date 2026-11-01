/**
 * What the person sees of their plan: closed things stay visible and say "Доступно после оплаты", the cabinet has a
 * working counter, a warning comes ten messages before the end, and the tariffs screen exists. Source-level wiring
 * checks over the screens (the visual side was looked at in a browser).
 * Run: ./node_modules/.bin/tsx.cmd supabase/functions/_shared/planLocksWiring.cases.test.ts
 */

import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const src = (path: string) => readFileSync(new URL(`../../../src/${path}`, import.meta.url), "utf8");
const chat = src("components/screens/ChatScreen.tsx");
const memory = src("components/screens/MemoryScreen.tsx");
const dynamics = src("components/screens/ConversationDynamicsScreen.tsx");
const profile = src("components/screens/ProfileScreen.tsx");
const hub = src("components/ConversationHubNav.tsx");
const app = src("App.tsx");
const appContext = src("context/AppContext.tsx");
const types = src("types/index.ts");
const screensIndex = src("components/screens/index.ts");

describe("the tariffs screen exists and can be reached", () => {
  it("is a screen of the app, for signed-in people, with a way back", () => {
    assert.match(types, /\|\s*'tariffs'/);
    assert.match(appContext, /AUTHENTICATED_SCREENS: Screen\[\] = \[[^\]]*'tariffs'/);
    assert.match(appContext, /case 'tariffs':/);
    assert.match(app, /case 'tariffs':\s*return user \? <TariffsScreen \/> : <WelcomeScreen \/>/);
    assert.match(screensIndex, /export \{ TariffsScreen \} from '\.\/TariffsScreen'/);
  });

  it("the plan and the paywall are available to every screen", () => {
    assert.match(app, /<PlanProvider>/);
    assert.match(app, /<PaywallProvider>\s*<AppContent \/>\s*<\/PaywallProvider>/);
  });
});

describe("the chat", () => {
  it("the attach button and the microphone stay visible; closed, they open the notice instead of the picker", () => {
    assert.match(chat, /has\('fileAttachments'\) \? fileInputRef\.current\?\.click\(\) : openPaywall\(\)/);
    assert.match(chat, /has\('voiceInput'\) \? handleVoicePress\(\) : openPaywall\(\)/);
    assert.match(chat, /!has\('fileAttachments'\) &&[^]*?<Lock/);
    assert.match(chat, /!has\('voiceInput'\) &&[^]*?<Lock/);
  });

  it("warns from ten messages left and refreshes the counter after every answered message", () => {
    assert.match(chat, /counter && counter\.warn && !counter\.unlimited && \(\s*<LowMessagesNotice counter=\{counter\} \/>/);
    const save = chat.indexOf(".update({ last_message_at: now })");
    const refresh = chat.indexOf("void refreshPlan();", save);
    assert.ok(save > 0 && refresh > save, "the counter is read again after the turn is saved");
  });
});

describe("the sections", () => {
  it("memory: the whole content is replaced by the closed panel on a plan without memory (the export too)", () => {
    assert.match(memory, /!planHas\('crossMemory'\) \? \(\s*<LockedMemoryPanel cardBase=\{cardBase\} \/>/);
  });

  it("dynamics: a plan without it sees the section's name and the button, nothing else", () => {
    assert.match(dynamics, /if \(!planHas\('conversationDynamics'\)\) \{[^]*?<LockedFeaturePanel/);
  });

  it("the section tabs show a lock on what is closed", () => {
    assert.match(hub, /feature: 'crossMemory'/);
    assert.match(hub, /feature: 'conversationDynamics'/);
    assert.match(hub, /<Lock /);
  });
});

describe("the cabinet", () => {
  it("shows the real counter and the way to the tariffs, not the old daily figure", () => {
    assert.match(profile, /counterLine\(counter\)/);
    assert.match(profile, /navigateTo\('tariffs'\)/);
    assert.doesNotMatch(profile, /сегодня \$\{remaining\}/);
    assert.doesNotMatch(profile, /fetchUsageTier/);
  });
});

describe("what the audit found", () => {
  it("a failed read of the plan keeps what is known instead of unlocking everything", () => {
    const context = src("context/PlanContext.tsx");
    assert.match(context, /if \(next\) setRow\(next\);/);
    assert.doesNotMatch(context, /setRow\(await fetchUsageRow/);
  });

  it("the number of conversations comes from the database (the plan or a number given by hand), not from a list in the app", () => {
    const rooms = src("lib/roomLimits.ts");
    assert.doesNotMatch(rooms, /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/, "no person's id in the app");
    assert.match(src("context/PlanContext.tsx"), /getMaxRooms\(tier, row\?\.max_conversations_override\)/);
    const main = src("components/screens/MainScreen.tsx");
    assert.match(main, /canCreateRoom\(conversations\.length, maxConversations\)/);
    assert.doesNotMatch(main, /hasUnlimitedRooms/);
  });

  it("the pay button cannot silently become a dead one: it stays closed while no payment is connected", () => {
    const payments = src("lib/payments.ts");
    assert.match(payments, /PAYMENT_AVAILABLE = false/, "flip this only together with a real handler on the button");
    const tariffs = src("components/screens/TariffsScreen.tsx");
    assert.match(tariffs, /<button\s+type="button"\s+disabled\s+className/);
    assert.doesNotMatch(tariffs, /PAYMENT_AVAILABLE \? 'Оплатить'/, "no label that promises a payment the button cannot take");
  });

  it("the free refusal and the card say the months correctly (from the one helper)", () => {
    for (const file of ["lib/planCopy.ts", "lib/messageCounter.ts"]) {
      assert.match(src(file), /monthsPhrase\(/, file);
      assert.doesNotMatch(src(file), /renewAfterIdleMonths[^\n]*месяца/, `${file}: no hand-written plural`);
    }
  });
});

describe("the words", () => {
  it("the label of a closed thing is written once, in planCopy, and used everywhere", () => {
    const planCopy = src("lib/planCopy.ts");
    assert.match(planCopy, /LOCKED_LABEL = 'Доступно после оплаты'/);
    for (const file of ["context/PaywallContext.tsx", "components/LockedBadge.tsx"]) {
      assert.match(src(file), /LOCKED_LABEL/, file);
      assert.doesNotMatch(src(file), /'Доступно после оплаты'/, `${file} does not repeat the words`);
    }
  });
});
