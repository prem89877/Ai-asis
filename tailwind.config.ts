import type { Config } from "tailwindcss";

const config: Config = {
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
    "./lib/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: { DEFAULT: "#2563EB", hover: "#1D4ED8", soft: "#EFF6FF" },
        canvas: "#F8FAFC",
        ink: { DEFAULT: "#1E293B", muted: "#475569" },
        success: { DEFAULT: "#10B981", ink: "#047857", soft: "#ECFDF5" },
      },
      fontFamily: {
        sans: ["var(--font-inter)", "ui-sans-serif", "system-ui", "sans-serif"],
      },
      boxShadow: {
        card: "0 1px 2px rgba(30,41,59,0.06), 0 8px 24px -12px rgba(30,41,59,0.12)",
      },
    },
  },
  plugins: [],
};

export default config;
