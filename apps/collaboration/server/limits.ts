/** Sizes every way into a project agrees on: uploads, zip imports, sync, runners and templates. */
export const TEXT_BYTES = 2_000_000,
  /** One figure, PDF or data file. */
  BINARY_BYTES = 100_000_000,
  PROJECT_BYTES = 1_000_000_000,
  PROJECT_FILES = 5000,
  /** An uploaded .zip, sent as the raw request body. */
  ZIP_BYTES = 500_000_000;
/** A JSON body that carries one binary file as base64. */
export const BINARY_JSON_BYTES = Math.ceil(BINARY_BYTES / 3) * 4 + 100_000;
/** "100 MB", "1 GB": how the limits read in messages. */
export const sizeText = (bytes: number) =>
  bytes >= 1_000_000_000 ? `${bytes / 1_000_000_000} GB` : `${Math.round(bytes / 1_000_000)} MB`;
