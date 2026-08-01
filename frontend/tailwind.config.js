/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        'dark': '#0A0E27',
        'dark-surface': '#1A1F3A',
        'off-white': '#F0F4F8',
        // Keep Tailwind's built-in emerald/amber shade maps intact. Defining
        // either name as a flat color here removes every `*-300`, `*-400`,
        // etc. utility from the compiled stylesheet.
        // Theme-aware CSS variable colors
        'theme-bg': 'var(--color-bg)',
        'theme-surface': 'var(--color-surface)',
        'theme-surface-raised': 'var(--color-surface-raised)',
        'theme-surface-strong': 'var(--color-surface-strong)',
        'theme-surface-hover': 'var(--color-surface-hover)',
        'theme-border': 'var(--color-border)',
        'theme-border-strong': 'var(--color-border-strong)',
        'theme-text': 'var(--color-text)',
        'theme-text-muted': 'var(--color-text-muted)',
        'theme-text-subtle': 'var(--color-text-subtle)',
      },
      backdropFilter: {
        'none': 'none',
        'sm': 'blur(4px)',
        'md': 'blur(12px)',
        'lg': 'blur(20px)',
      },
      keyframes: {
        'slide-in': {
          '0%': { transform: 'translateX(100%)', opacity: '0' },
          '100%': { transform: 'translateX(0)', opacity: '1' },
        },
        'pulse-glow': {
          '0%, 100%': { 
            boxShadow: '0 0 15px rgba(16, 185, 129, 0.2), 0 0 30px rgba(16, 185, 129, 0.1)',
            borderColor: 'rgba(16, 185, 129, 0.15)'
          },
          '50%': { 
            boxShadow: '0 0 25px rgba(16, 185, 129, 0.4), 0 0 50px rgba(16, 185, 129, 0.2)',
            borderColor: 'rgba(16, 185, 129, 0.3)'
          },
        },
      },
      animation: {
        'slide-in': 'slide-in 0.3s ease-out',
        'pulse-glow': 'pulse-glow 2s ease-in-out infinite',
      },
    },
  },
  plugins: [],
}
