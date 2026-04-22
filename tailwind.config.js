/** @type {import('tailwindcss').Config} */
export default {
  content: ['./index.html', './src/**/*.{js,ts,jsx,tsx}'],
  theme: {
    extend: {
      fontFamily: {
        display: ['"Syne"', 'sans-serif'],
        mono:    ['"JetBrains Mono"', 'monospace'],
        body:    ['"DM Sans"', 'sans-serif'],
      },
      colors: {
        ink: {
          950: '#080a0e',
          900: '#0f1117',
          800: '#181c25',
          700: '#222636',
          600: '#2e3347',
          500: '#3d4460',
        },
        signal: {
          green:  '#00e5a0',
          red:    '#ff4060',
          amber:  '#ffb830',
          blue:   '#3d8eff',
          purple: '#a259ff',
        },
      },
      animation: {
        'fade-up':   'fadeUp 0.4s ease forwards',
        'fade-in':   'fadeIn 0.3s ease forwards',
        'pulse-dot': 'pulseDot 2s ease-in-out infinite',
      },
      keyframes: {
        fadeUp:   { '0%': { opacity: '0', transform: 'translateY(12px)' }, '100%': { opacity: '1', transform: 'translateY(0)' } },
        fadeIn:   { '0%': { opacity: '0' }, '100%': { opacity: '1' } },
        pulseDot: { '0%,100%': { opacity: '1' }, '50%': { opacity: '0.3' } },
      },
    },
  },
  plugins: [],
}
