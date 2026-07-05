/** Config condivisa da index.html e welcome.html (stessa palette del vecchio
 *  inline tailwind.config). Build: npm run build:css (vedi package.json). */
module.exports = {
  darkMode: 'class',
  content: ['./index.html', './welcome.html', './app.js'],
  theme: {
    extend: {
      colors: {
        accent: { DEFAULT: '#FF9500', hover: '#F08600', soft: '#FFF4E5', darksoft: '#2c1e0a' },
        ink: { DEFAULT: '#1d1d1f', soft: '#6e6e73', faint: '#a1a1a6' },
        darkBg: '#121214',
        darkCard: '#1c1c1e',
        darkBorder: '#2c2c2e'
      },
      borderRadius: { xl2: '1.25rem' }
    }
  }
};
