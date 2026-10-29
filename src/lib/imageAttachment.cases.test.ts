import {
  ATTEMPTS,
  checkImageBeforeReading,
  fitToBudget,
  IMAGE_MAX_BASE64_CHARS,
  IMAGE_MAX_COUNT,
  IMAGE_PICK_BYTES_LIMIT,
  imageProblemMessage,
  isImageFile,
  scaleToFit,
} from './imageAttachment';

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}
function same(a: unknown, b: unknown, message: string): void {
  if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${message}: ${JSON.stringify(a)} != ${JSON.stringify(b)}`);
}

async function main(): Promise<void> {
  // The budget is the server's: 1,000,000 base64 characters per picture, three pictures per message.
  assert(IMAGE_MAX_BASE64_CHARS === 1_000_000, 'budget equals the server budget');
  assert(IMAGE_MAX_COUNT === 3, 'three pictures');

  // Which files are pictures, and what is refused before reading anything.
  assert(isImageFile({ type: 'image/png', name: 'a.png' }), 'png');
  assert(isImageFile({ type: 'image/heic', name: 'a.heic' }), 'heic is tried (Safari can open it)');
  assert(isImageFile({ type: '', name: 'IMG_1.JPG' }), 'a picture without a type is recognised by its ending');
  assert(!isImageFile({ type: 'application/pdf', name: 'a.pdf' }), 'pdf is not a picture');
  same(checkImageBeforeReading({ type: 'image/png', size: 1000 }, 0), null, 'a normal picture is fine');
  same(checkImageBeforeReading({ type: 'image/png', size: 1000 }, 3), 'too_many', 'a fourth picture');
  same(checkImageBeforeReading({ type: 'image/png', size: IMAGE_PICK_BYTES_LIMIT + 1 }, 0), 'too_big_file', 'a huge file');

  // Shrinking: the longest edge fits 2,048, the shape stays, small pictures are not enlarged.
  same(scaleToFit(4000, 3000), { width: 2048, height: 1536 }, 'a 12 MP landscape photo');
  same(scaleToFit(1170, 2532), { width: 946, height: 2048 }, 'a tall phone screenshot');
  same(scaleToFit(800, 600), { width: 800, height: 600 }, 'a small picture stays');
  same(scaleToFit(1, 5000), { width: 1, height: 2048 }, 'never a zero edge');

  // Fitting: the first attempt that is small enough wins; none small enough means null.
  const tried: Array<{ scale: number; quality: number }> = [];
  const fitsOnThird = await fitToBudget(async (attempt) => {
    tried.push(attempt);
    return 'x'.repeat(tried.length < 3 ? 1_200_000 : 900_000);
  });
  assert(fitsOnThird === 'x'.repeat(900_000), 'the third attempt is the first that fits');
  same(tried, ATTEMPTS.slice(0, 3), 'attempts go from the best quality down, in order');
  const never = await fitToBudget(async () => 'x'.repeat(1_200_000));
  assert(never === null, 'nothing fits');
  const exactly = await fitToBudget(async () => 'y'.repeat(IMAGE_MAX_BASE64_CHARS));
  assert(exactly !== null, 'exactly the budget is allowed');

  for (const problem of ['unsupported', 'too_many', 'too_big_file', 'unreadable', 'too_big'] as const) {
    assert(imageProblemMessage(problem).length > 10, `a line for ${problem}`);
  }

  console.log('imageAttachment.cases.test.ts passed');
}

main().catch((error) => {
  throw error;
});
