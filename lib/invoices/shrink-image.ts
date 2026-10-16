// Browser-only helper: phone photos are often larger than the upload cap (MAX_UPLOAD_BYTES). A JPG / PNG that is too big is
// re-encoded as a JPEG (longest side limited, quality lowered step by step) until it fits. PDFs are never touched, and a file
// that is already small enough is returned as it is. If anything fails the original file is returned, and the caller then
// shows the normal "too large" message.

const SIDES = [3200, 2600, 2000, 1600];
const QUALITIES = [0.9, 0.82, 0.74, 0.66];

function toBlob(canvas: HTMLCanvasElement, quality: number): Promise<Blob | null> {
  return new Promise((resolve) => canvas.toBlob((b) => resolve(b), "image/jpeg", quality));
}

export async function shrinkImageToFit(file: File, maxBytes: number): Promise<File> {
  if (file.size <= maxBytes) return file;
  if (file.type !== "image/jpeg" && file.type !== "image/png") return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: "from-image" });
    try {
      for (const side of SIDES) {
        const scale = Math.min(1, side / Math.max(bitmap.width, bitmap.height));
        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.round(bitmap.width * scale));
        canvas.height = Math.max(1, Math.round(bitmap.height * scale));
        const ctx = canvas.getContext("2d");
        if (!ctx) return file;
        ctx.fillStyle = "#ffffff"; // a PNG with transparency must not turn black in a JPEG
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
        for (const q of QUALITIES) {
          const blob = await toBlob(canvas, q);
          if (blob && blob.size <= maxBytes) {
            const name = file.name.replace(/\.[^.]*$/, "") || "invoice";
            return new File([blob], `${name}.jpg`, { type: "image/jpeg", lastModified: file.lastModified });
          }
        }
      }
    } finally {
      bitmap.close();
    }
  } catch {
    // fall through: the original file is returned
  }
  return file;
}
