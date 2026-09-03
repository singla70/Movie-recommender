/** @type {import('tailwindcss').Config} */
export default {
  content: ["./index.html", "./src/**/*.{js,jsx}"],
  theme: {
    extend: {
      colors: {
        theatre: {
          bg: "#0E0D0F",
          surface: "#17161A",
          surface2: "#1E1C21",
          border: "#2A282E",
          text: "#F2F0EC",
          muted: "#8B8891",
          faint: "#57545C",
        },
        gold: {
          DEFAULT: "#C9A24B",
          soft: "#E0C171",
          dim: "#8A7238",
        },
        teal: {
          DEFAULT: "#4FB8A8",
          soft: "#7ECEC1",
          dim: "#316158",
        },
      },
      fontFamily: {
        display: ["Fraunces", "serif"],
        sans: ["IBM Plex Sans", "sans-serif"],
        mono: ["IBM Plex Mono", "monospace"],
      },
      backgroundImage: {
        sprocket:
          "repeating-linear-gradient(to right, transparent, transparent 14px, #2A282E 14px, #2A282E 16px)",
      },
    },
  },
  plugins: [],
};
