/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        teslyr: {
          void: '#050505',
          ink: '#0c0c0c',
          panel: '#141414',
          line: '#2a2a2a',
          mute: '#8a8a8a',
          soft: '#c8c8c8',
          crimson: '#e10600',
          ember: '#ff3b30',
          live: '#2ee66b',
        },
      },
      fontFamily: {
        display: ['Syne', 'system-ui', 'sans-serif'],
        sans: ['Outfit', 'system-ui', 'sans-serif'],
      },
      boxShadow: {
        glow: '0 0 48px rgba(225, 6, 0, 0.18)',
      },
      keyframes: {
        pulseDot: {
          '0%, 100%': { opacity: '1', transform: 'scale(1)' },
          '50%': { opacity: '0.45', transform: 'scale(0.85)' },
        },
        riseIn: {
          from: { opacity: '0', transform: 'translateY(12px)' },
          to: { opacity: '1', transform: 'translateY(0)' },
        },
        brandPulse: {
          '0%, 100%': { opacity: '0.55' },
          '50%': { opacity: '0.9' },
        },
      },
      animation: {
        pulseDot: 'pulseDot 2s ease-in-out infinite',
        riseIn: 'riseIn 0.45s ease-out both',
        brandPulse: 'brandPulse 4s ease-in-out infinite',
      },
    },
  },
  plugins: [],
};
