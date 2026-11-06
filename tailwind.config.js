/** @type {import('tailwindcss').Config} */
/**
 * unslop 设计底座（方向：招聘档案 / 仪表刻度）
 * - 表面只用一条冷调石墨中性 ramp，不承载彩色
 * - 品牌橙收敛为唯一 accent，并压暗到白底 4.5:1 以上
 * - 保留全部旧 token 名，避免零散引用出现「背景消失 / 文字透明」；
 *   旧名一律指向新值，因此历史 className 会自然收敛到新体系
 */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        // 唯一强调色：压暗后的品牌橙（#C2410C 在白底约 5.2:1）
        accent: {
          DEFAULT: '#C2410C',
          soft: '#FFF4ED',
          strong: '#9A3412',
        },
        // 冷调石墨中性 ramp（light / ink tinted）
        surface: {
          page: '#F5F7FA',
          darkest: '#FFFFFF',
          dark: '#F4F6F9',
          medium: '#ECEFF4',
          light: '#E4E8EF',
          hairline: '#E2E6ED',
        },
        text: {
          primary: '#111827',
          secondary: '#4B5563',
          muted: '#6B7487',
        },
        // 语义色统一降饱和，只在表达状态时出现
        success: '#15803D',
        danger: '#DC2626',
        warning: '#B45309',
        info: '#1D4ED8',
        // 兼容旧引用：品牌色与 primary 全系列收敛到同一个 accent
        brand: {
          orange: '#C2410C',
          blue: '#1E3A8A',
          blueDark: '#15265F',
        },
        primary: {
          DEFAULT: '#C2410C',
          light: '#C2410C',
          lighter: '#9A3412',
        },
      },
      fontFamily: {
        sans: ['PingFang SC', 'system-ui', 'sans-serif'],
      },
      // 旧渐变名保留，但改成同色纯色填充，不再是跨色相渐变
      backgroundImage: {
        'gradient-primary': 'linear-gradient(0deg, #C2410C, #C2410C)',
        'gradient-brand': 'linear-gradient(0deg, #C2410C, #C2410C)',
        'gradient-card': 'linear-gradient(0deg, #F4F6F9, #F4F6F9)',
      },
      // 旧发光名保留，改成中性小阴影
      boxShadow: {
        'glow': '0 1px 2px rgba(17, 24, 39, 0.05)',
        'glow-lg': '0 8px 24px rgba(17, 24, 39, 0.08)',
        'card': '0 1px 2px rgba(17, 24, 39, 0.05)',
        'float': '0 8px 24px rgba(17, 24, 39, 0.08)',
      },
    },
  },
  plugins: [
    require('tailwindcss-animate'),
  ],
}
