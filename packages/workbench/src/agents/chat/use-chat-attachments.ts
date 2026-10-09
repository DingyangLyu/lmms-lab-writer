"use client";
import {
  type ClipboardEvent,
  type Dispatch,
  type DragEvent,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { workbenchI18n as i18n } from "../../i18n";
import { agentPlatform } from "../platform";
import { importBrowserDocument } from "./files";
import { type ChatImageFile, imageMime, MAX_IMAGES, readBrowserImage } from "./images";

type Imported = { files: ChatImageFile[]; notices: string[] };
const message = (cause: unknown) => String(cause).replace(/^Error: /, "");

/** Each file succeeds or fails on its own; a rejected image can still go as a plain file. */
async function importEach<T>(
  items: T[],
  project: string | undefined,
  name: (item: T) => string,
  image: (item: T) => boolean,
  readImage: (item: T) => Promise<ChatImageFile>,
  readDocument: (item: T) => Promise<ChatImageFile>,
): Promise<Imported> {
  const result: Imported = { files: [], notices: [] };
  for (const item of items) {
    try {
      if (!image(item)) {
        result.files.push(await readDocument(item));
        continue;
      }
      try {
        result.files.push(await readImage(item));
      } catch (cause) {
        if (!project) throw cause;
        result.files.push(await readDocument(item));
        result.notices.push(
          i18n.t("msg.nameCannotBeSentAsAnImageErrorSoItWasAtt", {
            name: name(item),
            error: message(cause),
          }),
        );
      }
    } catch (cause) {
      result.notices.push(`${name(item)}：${message(cause)}`);
    }
  }
  return result;
}

export function useChatAttachments(
  files: ChatImageFile[],
  setFiles: Dispatch<SetStateAction<ChatImageFile[]>>,
  active = true,
  disabled = false,
  project?: string,
) {
  const areaRef = useRef<HTMLFieldSetElement>(null);
  const pickerRef = useRef<HTMLInputElement>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const filesRef = useRef(files);
  filesRef.current = files;
  // Imports run one batch at a time; later drops/pastes wait instead of being dropped.
  const chain = useRef<Promise<void>>(Promise.resolve());
  const pending = useRef(0);
  const scopeRef = useRef(project);
  scopeRef.current = project;
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const add = useCallback(
    (read: () => Promise<Imported>, count: number) => {
      if (disabled || !count) return Promise.resolve();
      if (filesRef.current.length + pending.current + count > MAX_IMAGES) {
        setError(i18n.t("msg.addAtMostCountAttachmentsAtATimeImagesUp", { count: MAX_IMAGES }));
        return Promise.resolve();
      }
      pending.current += count;
      setLoading(true);
      setError(null);
      const expectedProject = scopeRef.current;
      const run = chain.current.then(async () => {
        try {
          const next = await read();
          if (!mounted.current || scopeRef.current !== expectedProject) return;
          setFiles((current) => [
            ...current,
            ...next.files.filter(
              (file, index) =>
                !current.some((existing) => existing.url === file.url) &&
                next.files.findIndex((candidate) => candidate.url === file.url) === index,
            ),
          ]);
          if (next.notices.length) setError(next.notices.join("\n"));
        } catch (cause) {
          if (mounted.current) setError(message(cause));
        } finally {
          pending.current -= count;
          if (mounted.current && !pending.current) setLoading(false);
        }
      });
      chain.current = run;
      return run;
    },
    [disabled, setFiles],
  );
  const addPaths = useCallback(
    (paths: string[]) =>
      add(
        () =>
          importEach(
            paths,
            project,
            (path) => path.split(/[\\/]/).pop() || path,
            (path) => Boolean(imageMime(path)),
            (path) => {
              const read = agentPlatform().readImagePath;
              if (!read) throw new Error(i18n.t("msg.onlyImagesCanBeAttachedHere"));
              return read(path);
            },
            (path) => {
              if (!project) throw new Error(i18n.t("msg.openAProjectBeforeAddingFiles"));
              const copy = agentPlatform().importDocumentPath;
              if (!copy) throw new Error(i18n.t("msg.onlyImagesCanBeAttachedHere"));
              return copy(project, path);
            },
          ),
        paths.length,
      ),
    [add, project],
  );
  const addFiles = (items: File[]) =>
    add(
      () =>
        importEach(
          items,
          project,
          (file) => file.name || i18n.t("msg.pastedFile"),
          (file) => Boolean(imageMime(file.name)) || IMAGE_MIMES.includes(file.type),
          readBrowserImage,
          (file) => importBrowserDocument(project, file),
        ),
      items.length,
    );
  const choose = async () => {
    const choosePaths = agentPlatform().choosePaths;
    if (!choosePaths) {
      pickerRef.current?.click();
      return;
    }
    try {
      const paths = await choosePaths(i18n.t("msg.addFilesOrImages"));
      if (paths) await addPaths(paths);
    } catch (cause) {
      setError(String(cause));
    }
  };
  useEffect(() => {
    const onDropPaths = agentPlatform().onDropPaths;
    if (!active || disabled || !onDropPaths) return;
    let cancelled = false;
    let unlisten: (() => void) | undefined;
    void onDropPaths((paths, { x, y }) => {
      const rect = areaRef.current?.getBoundingClientRect();
      if (rect && x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom)
        void addPaths(paths);
    })
      .then((stop) => {
        if (cancelled) stop();
        else unlisten = stop;
      })
      .catch((cause) => setError(String(cause)));
    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [active, disabled, addPaths]);
  const onPaste = (event: ClipboardEvent) => {
    const images = Array.from(event.clipboardData.items)
      .filter((item) => item.kind === "file")
      .flatMap((item) => {
        const file = item.getAsFile();
        return file ? [file] : [];
      });
    if (images.length) {
      event.preventDefault();
      void addFiles(images);
    }
  };
  const onDrop = (event: DragEvent) => {
    if (!event.dataTransfer.files.length) return;
    event.preventDefault();
    void addFiles(Array.from(event.dataTransfer.files));
  };
  return { areaRef, pickerRef, error, loading, choose, addFiles, onPaste, onDrop };
}

const IMAGE_MIMES = ["image/png", "image/jpeg", "image/webp", "image/gif"];
