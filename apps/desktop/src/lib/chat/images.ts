import { convertFileSrc } from "@tauri-apps/api/core";

export type ChatImageFile = {
  url: string;
  mime: string;
  filename: string;
  kind?: "document";
  path?: string;
  size?: number;
  sha256?: string;
};
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_IMAGES = 6;
export const IMAGE_ACCEPT = "image/png,image/jpeg,image/webp,image/gif";

export function imageMime(name: string): string | undefined {
  return (
    {
      png: "image/png",
      jpg: "image/jpeg",
      jpeg: "image/jpeg",
      webp: "image/webp",
      gif: "image/gif",
    } as Record<string, string>
  )[name.split(".").pop()?.toLowerCase() ?? ""];
}

export function validateImage(file: { size: number; type: string; name: string }): string {
  const mime = file.type || imageMime(file.name);
  if (!mime || !IMAGE_ACCEPT.split(",").includes(mime))
    throw new Error("请选择 PNG、JPEG、WebP 或 GIF 图片。");
  if (!file.size || file.size > MAX_IMAGE_BYTES)
    throw new Error("单张图片须小于 10 MB，且不能为空。");
  return mime;
}

export async function readBrowserImage(file: File): Promise<ChatImageFile> {
  const mime = validateImage(file);
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () =>
      typeof reader.result === "string"
        ? resolve(reader.result)
        : reject(new Error("无法读取图片"));
    reader.onerror = () => reject(new Error(`无法读取 ${file.name}`));
    reader.onabort = () => reject(new Error("图片读取已取消"));
    reader.readAsDataURL(file.type ? file : new Blob([file], { type: mime }));
  });
  return { url, mime, filename: file.name || "粘贴图片.png" };
}

export function imageSource(url: string, directory?: string): string | undefined {
  if (/^(data:image\/(png|jpeg|webp|gif);base64,|blob:|asset:|https?:\/\/)/i.test(url)) return url;
  let path = url;
  if (url.startsWith("file://")) {
    try {
      path = decodeURIComponent(new URL(url).pathname);
    } catch {
      return undefined;
    }
  } else if (!url.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(url)) {
    if (!directory || /^[a-z]+:/i.test(url)) return undefined;
    path = `${directory}/${url.replace(/^\.\//, "")}`;
  }
  return convertFileSrc(path);
}
