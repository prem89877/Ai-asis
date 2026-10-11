const steps = [
  { title: "Upload", text: "Add invoices as PDFs or images, one or in bulk." },
  { title: "Extract", text: "AI reads vendor, GST and amount fields into a table." },
  { title: "Review", text: "Check flagged errors and confirm or correct the data." },
  { title: "Export", text: "Download verified invoices as an Excel file." },
];

export function HowItWorks() {
  return (
    <section id="how-it-works" className="section-y">
      <div className="container-page">
        <h2 className="text-3xl font-bold tracking-tight sm:text-4xl">How it works</h2>
        <ol className="mt-12 grid gap-6 sm:grid-cols-2 lg:grid-cols-4">
          {steps.map((s, i) => (
            <li key={s.title} className="rounded-xl border border-slate-200 bg-white p-6 shadow-card">
              <span className="flex h-8 w-8 items-center justify-center rounded-full bg-brand text-sm font-bold text-white">
                {i + 1}
              </span>
              <h3 className="mt-4 text-lg font-semibold">{s.title}</h3>
              <p className="mt-2 text-sm text-ink-muted">{s.text}</p>
            </li>
          ))}
        </ol>
      </div>
    </section>
  );
}
