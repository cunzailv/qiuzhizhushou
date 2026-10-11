/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        brand: {
          orange: '#FF7A2F',
          blue: '#1E3A8A',
          blueDark: '#15265F',
        },
        primary: {
          DEFAULT: '#F97316',
          light: '#FB923C',
          lighter: '#FDBA74',
        },
        surface: {
          darkest: '#FFFFFF',
          dark: '#F5F6F8',
          medium: '#ECEEF2',
          light: '#E2E5EA',
        },
        text: {
          primary: '#111827',
          secondary: '#4B5563',
          muted: '#9CA3AF',
        },
        success: '#10B981',
        danger: '#EF4444',
        warning: '#F59E0B',
        info: '#3B82F6',
      },
      fontFamily: {
        sans: ['PingFang SC', 'system-ui', 'sans-serif'],
      },
      backgroundImage: {
        'gradient-primary': 'linear-gradient(135deg, #FF7A2F 0%, #F97316 50%, #FB923C 100%)',
        'gradient-brand': 'linear-gradient(135deg, #FF7A2F 0%, #1E3A8A 100%)',
        'gradient-card': 'linear-gradient(135deg, rgba(249,115,22,0.12) 0%, rgba(30,58,138,0.08) 100%)',
      },
      boxShadow: {
        'glow': '0 0 20px rgba(249, 115, 22, 0.3)',
        'glow-lg': '0 0 40px rgba(249, 115, 22, 0.4)',
      },
    },
  },
  plugins: [
    require('tailwindcss-animate'),
  ],
}
