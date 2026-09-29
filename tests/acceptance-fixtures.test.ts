import { expect, test } from "bun:test";
import { inflateSync } from "node:zlib";
import { acceptanceRedSquarePng } from "../scripts/acceptance-fixtures";

test("the installed image-input fixture fully decodes to a red square", () => {
  const png = acceptanceRedSquarePng;
  expect(png.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  expect([width, height]).toEqual([64, 64]);
  expect(png[25]).toBe(2); // RGB, three bytes per pixel.
  const chunks: Buffer[] = [];
  for (let offset = 8; offset + 12 <= png.length;) {
    const length = png.readUInt32BE(offset);
    const kind = png.toString("ascii", offset + 4, offset + 8);
    if (kind === "IDAT") chunks.push(png.subarray(offset + 8, offset + 8 + length));
    offset += length + 12;
    if (kind === "IEND") break;
  }
  const raw = inflateSync(Buffer.concat(chunks));
  const stride = width * 3;
  expect(raw.length).toBe(height * (stride + 1));
  const decoded = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y += 1) {
    const filter = raw[y * (stride + 1)]!;
    expect(filter).toBeGreaterThanOrEqual(0);
    expect(filter).toBeLessThanOrEqual(4);
    for (let x = 0; x < stride; x += 1) {
      const value = raw[y * (stride + 1) + 1 + x]!;
      const left = x >= 3 ? decoded[y * stride + x - 3]! : 0;
      const up = y > 0 ? decoded[(y - 1) * stride + x]! : 0;
      const upperLeft = y > 0 && x >= 3 ? decoded[(y - 1) * stride + x - 3]! : 0;
      const prediction = left + up - upperLeft;
      const distances = [Math.abs(prediction - left), Math.abs(prediction - up), Math.abs(prediction - upperLeft)];
      const paeth = distances[0]! <= distances[1]! && distances[0]! <= distances[2]! ? left
        : distances[1]! <= distances[2]! ? up : upperLeft;
      decoded[y * stride + x] = (value + [0, left, up, Math.floor((left + up) / 2), paeth][filter]!) & 0xff;
    }
  }
  for (let pixel = 0; pixel < width * height; pixel += 1) {
    expect([...decoded.subarray(pixel * 3, pixel * 3 + 3)]).toEqual([255, 0, 0]);
  }
});
