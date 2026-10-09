/** pdf.js decodes in a worker; Vite serves it as a file of its own. */
import workerUrl from "pdfjs-dist/build/pdf.worker.min.mjs?url";
import { pdfjs } from "react-pdf";

pdfjs.GlobalWorkerOptions.workerSrc = workerUrl;
