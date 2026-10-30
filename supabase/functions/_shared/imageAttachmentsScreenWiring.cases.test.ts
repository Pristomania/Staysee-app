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
    assert.match(screen, /getImagesCapability\(user\.id\)\.then\(/);
    // No special link or build setting any more: the answer comes from the server.
    assert.doesNotMatch(screen, /readImageBeta|imagesEnabledForUser|VITE_IMAGE_ATTACHMENTS/);
  });

  it("asks for the picture consent before the first picture, and goes on with the same files once it is saved", () => {
    const gate = picked.indexOf("!imagesConsent");
    assert.ok(gate > 0 && gate < picked.indexOf("attachImageFiles("), "the gate comes before the pictures are taken");
    assert.match(picked.slice(gate, gate + 300), /setImagesConsentOpen\(true\)/);
    assert.match(picked.slice(gate, gate + 300), /pendingImageFilesRef\.current = /);
    const accept = bodyOf(screen, "async function acceptImagesConsent()");
    assert.match(accept, /recordImagesConsent\(/);
    assert.match(accept, /markImagesConsentGiven\(user\.id\)/);
    assert.match(accept, /setImagesConsent\(true\)/);
    assert.match(accept, /await attachImageFiles\(/);
    // A consent that could not be saved lets nothing through.
    assert.ok(accept.indexOf("if (!saved)") < accept.indexOf("setImagesConsent(true)"));
    assert.match(screen, /\{imagesConsentOpen && \(\s*<ImagesConsentCard/);
    assert.match(screen, /setImagesConsentOpen\(false\);\s*setImagePreparing\(false\);|setImagePreparing\(false\);\s*setAttachedImages\(\[\]\);[\s\S]{0,120}setImagesConsentOpen\(false\)/);
  });

  it("shrinks a picked picture, and drops the result if a newer pick or another conversation came meanwhile", () => {
    const attach = bodyOf(screen, "async function attachImageFiles(");
    assert.match(picked, /imagesEnabled && isImageFile\(files\[0\]\)/);
    assert.match(picked, /await attachImageFiles\(pictures\)/);
    assert.match(attach, /const operation = \+\+fileOperationRef\.current/);
    assert.match(attach, /await prepareImageFile\(file\)/);
    const afterPrepare = attach.slice(attach.indexOf("await prepareImageFile(file)"));
    assert.match(afterPrepare.slice(0, 200), /operation !== fileOperationRef\.current/);
    assert.match(attach, /setImagePreparing\(false\)/);
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
    assert.match(screen, /setImagePreparing\(false\);\s*setAttachedImages\(\[\]\);\s*setImagesConsentOpen\(false\);\s*pendingImageFilesRef\.current = null;\s*\}, \[openConversationId\]\)/);
  });

  it("shows the description lines of a saved message as photo cards, searching only the text part", () => {
    assert.match(row, /splitPhotoBlocks\(msg\.content\)/);
    assert.match(row, /highlightSearchInText\(text, searchQuery\)/);
    assert.match(row, /photoPreviews\?\.\[photoIndex\]/);
    assert.match(screen, /photoPreviews=\{photoPreviewsRef\.current\.get\(msg\.id\)\}/);
  });
});

describe("the buttons of the message box", () => {
  const box = screen.slice(screen.indexOf("{/* Input field */}"), screen.indexOf("// ── Sub-components"));
  const SAME_SIZE = "flex h-10 w-10 shrink-0 items-center justify-center rounded-lg";

  it("puts attaching on the left as a plus, before the text field, and no longer as a paperclip", () => {
    const plus = box.indexOf('aria-label="Прикрепить файл"');
    const field = box.indexOf("onChange={handleInputChange}");
    assert.ok(plus > 0 && field > 0 && plus < field, "the plus comes before the text field");
    assert.match(box.slice(plus, plus + 700), /<Plus /);
    assert.doesNotMatch(screen, /Paperclip/);
  });

  it("makes the plus, the microphone, send and stop the same size, so the row is even", () => {
    assert.ok(box.split(SAME_SIZE).length - 1 >= 4, "plus, microphone, send and stop share one size");
    assert.doesNotMatch(box, /shrink-0 p-1\.5/);
  });

  it("keeps the text in line with the buttons, and the buttons close together", () => {
    const field = box.slice(box.indexOf("onChange={handleInputChange}") - 400, box.indexOf("onChange={handleInputChange}") + 400);
    assert.match(field, /py-2/);
    assert.match(box, /flex items-end gap-2 rounded-xl/);
  });
});
