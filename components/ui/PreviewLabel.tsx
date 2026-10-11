export function PreviewLabel({ children = "UI preview with sample data" }: { children?: string }) {
  return (
    <span className="inline-flex items-center rounded-full border border-amber-300 bg-amber-50 px-2.5 py-1 text-xs font-medium text-amber-900">
      {children}
    </span>
  );
}
