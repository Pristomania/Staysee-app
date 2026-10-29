import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const screen = readFileSync(new URL("../../../src/components/screens/ChatScreen.tsx", import.meta.url), "utf8")
  .split("\r\n")
  .join("\n");

// The checks look inside the one function they are about, as in fileAttachmentWiring.cases.test.ts.
function bodyOf(source: string, header: string): string {
  const start = source.indexOf(header);
  assert.ok(start >= 0, `${header} is missing`);
  const end = source.indexOf("\n  }\n", start);
  assert.ok(end > start, `${header} has no end`);
  return source.slice(start, end);
}

describe("pictures in the chat screen", () => {
  const picked = bodyOf(screen, "async function handleFilePicked(");
  const send = bodyOf(screen, "async function handleSend()");
  const row = screen.slice(screen.indexOf("function MessageRow({"), screen.indexOf("function aiMessageStyle("));

  it("lets the file picker take pictures only for people the server says may attach them", () => {
    assert.match(screen, /accept=\{imagesEnabled \? '\.txt,\.md,\.docx,\.pdf,image\/\*' : '\.txt,\.md,\.docx,\.pdf'\}/);
    assert.match(screen, /multiple=\{imagesEnabled\}/);
    assert.match(screen, /const \[imagesEnabled, setImagesEnabled\] = useState\(false\);/);
    assert.match(screen, /getImagesAllowed\(user\.id\)\.then\(/);
    // No special link or build setting any more: the answer comes from the server.
    assert.doesNotMatch(screen, /readImageBeta|imagesEnabledForUser|VITE_IMAGE_ATTACHMENTS/);
  });

  it("shrinks a picked picture, and drops the result if a newer pick or another conversation came meanwhile", () => {
    assert.match(picked, /imagesEnabled && isImageFile\(files\[0\]\)/);
    assert.match(picked, /await prepareImageFile\(file\)/);
    const afterPrepare = picked.slice(picked.indexOf("await prepareImageFile(file)"));
    assert.match(afterPrepare.slice(0, 200), /operation !== fileOperationRef\.current/);
    assert.match(picked, /setImagePreparing\(false\)/);
    assert.doesNotMatch(picked.slice(0, picked.indexOf("const file = files[0];")), /handleSend\(|sendAiMessage\(/);
  });

  it("shows removable previews above the box", () => {
    const strip = screen.indexOf('aria-label="Прикреплённые картинки"');
    assert.ok(strip > 0 && strip < screen.indexOf("{/* Input field */}"));
    assert.match(screen, /aria-label="Убрать картинку"/);
  });

  it("shows the 'preparing' line while the first picture is being prepared, before any preview exists", () => {
    // Found in the browser check of 30.10: the line sat inside a strip that only existed once a picture was attached.
    assert.match(screen, /imagesEnabled && \(attachedImages\.length > 0 \|\| imagePreparing\) && \(/);
    const strip = screen.indexOf('aria-label="Прикреплённые картинки"');
    assert.match(screen.slice(strip, strip + 1800), /imagePreparing && \(\s*<p[^>]*role="status">Готовлю картинку…<\/p>/);
  });

  it("gives a message with pictures a wider bubble and stacks each card on a narrow screen", () => {
    // Found in the browser check of 30.10: at 390 px the description was a column of 177 px.
    assert.match(row, /photos\.length > 0 \? 'max-w-\[92%\] sm:max-w-\[70%\]' : 'max-w-\[70%\]'/);
    assert.match(row, /flex flex-col gap-2 sm:flex-row sm:items-start sm:gap-3/);
  });

  it("can send a message made only of pictures, and not while one is still being prepared", () => {
    assert.match(send, /\(!inputValue\.trim\(\) && attachedImages\.length === 0\)/);
    assert.match(send, /imagePreparing/);
    assert.match(screen, /disabled=\{\(!inputValue\.trim\(\) && attachedImages\.length === 0\) \|\| lengthState\.tooLong \|\| fileReading \|\| imagePreparing\}/);
    assert.match(screen, /disabled=\{fileReading \|\| imagePreparing\}/);
  });

  it("sends the pictures, saves the text the server used, and gives the pictures back if sending fails", () => {
    assert.match(send, /const sentImages = attachedImages;/);
    assert.match(send, /images: sentImages\.map\(/);
    assert.match(send, /userContent = aiResult\.userText \?\? content;/);
    assert.match(send, /insertChatMessage\(\s*convId,\s*'user',\s*userContent,/);
    const clear = send.indexOf("setAttachedImages([])");
    assert.ok(clear > 0 && clear < send.indexOf("await sendAiMessage("), "the pictures leave the strip before the request goes out");
    const fail = send.slice(send.indexOf("const failSend"), send.indexOf("const userCapture"));
    assert.match(fail, /setAttachedImages\(sentImages\)/);
  });

  it("starts a new turn when only the pictures changed", () => {
    assert.match(send, /const turnKey = `\$\{content\}\|img:/);
    assert.match(send, /resolveTurnId\(pendingTurnRef\.current, turnKey\)/);
  });

  it("clears the strip when another conversation is opened", () => {
    assert.match(screen, /setImagePreparing\(false\);\s*setAttachedImages\(\[\]\);\s*\}, \[openConversationId\]\)/);
  });

  it("shows the description lines of a saved message as photo cards, searching only the text part", () => {
    assert.match(row, /splitPhotoBlocks\(msg\.content\)/);
    assert.match(row, /highlightSearchInText\(text, searchQuery\)/);
    assert.match(row, /photoPreviews\?\.\[photoIndex\]/);
    assert.match(screen, /photoPreviews=\{photoPreviewsRef\.current\.get\(msg\.id\)\}/);
  });
});
