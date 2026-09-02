/** @type {import('tailwindcss').Config} */
module.exports = {
  content: [
    './app/**/*.{js,ts,jsx,tsx,mdx}',
    './components/**/*.{js,ts,jsx,tsx,mdx}',
  ],
  theme: {
    extend: {
      fontFamily: {
        sans: ['var(--font-inter)', 'system-ui', 'sans-serif'],
        serif: ['var(--font-source-serif)', 'Georgia', 'serif'],
      },
    },
  },
  plugins: [require('daisyui')],
  daisyui: {
    themes: [
      {
        findurjob: {
          primary: '#7c5cff',
          'primary-content': '#ffffff',
          secondary: '#22d3c8',
          'secondary-content': '#04211f',
          accent: '#f5a623',
          'accent-content': '#2b1a02',
          neutral: '#1c1c24',
          'neutral-content': '#e5e5ec',
          'base-100': '#0a0a0f',
          'base-200': '#131318',
          'base-300': '#1e1e27',
          'base-content': '#e5e5ec',
          info: '#38bdf8',
          success: '#34d399',
          warning: '#fbbf24',
          error: '#f87171',
          '--rounded-box': '1rem',
          '--rounded-btn': '0.5rem',
        },
      },
    ],
    darkTheme: 'findurjob',
  },
};
