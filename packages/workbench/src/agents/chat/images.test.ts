import { describe, expect, it } from "vitest";
import { imageMime, MAX_IMAGE_BYTES, validateImage } from "./images";

describe("chat image ingestion", () => {
  it("accepts screenshots and images without a browser MIME but rejects unsupported files", () => {
    expect(validateImage({ name: "截图.PNG", type: "", size: 300 })).toBe("image/png");
    expect(imageMime("figure.JPEG")).toBe("image/jpeg");
    expect(() =>
      validateImage({ name: "paper.pdf", type: "application/pdf", size: 300 }),
    ).toThrow();
    expect(() =>
      validateImage({ name: "bad.png", type: "image/png", size: MAX_IMAGE_BYTES + 1 }),
    ).toThrow();
    expect(() => validateImage({ name: "empty.png", type: "image/png", size: 0 })).toThrow();
  });
});
