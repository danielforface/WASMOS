module.exports = { content: ['./host/studio.template.html'], ...{
            darkMode: 'class',
            theme: {
                extend: {
                    colors: {
                        wasm: {
                            50: '#f0f4ff',
                            100: '#e0e9ff',
                            500: '#6366f1',
                            600: '#4f46e5',
                            700: '#4338ca',
                            900: '#1e1b4b',
                            accent: '#00f3ff',
                            neonGreen: '#00ff9d',
                            darkBg: '#090a0f',
                            panelBg: 'rgba(15, 23, 42, 0.75)'
                        }
                    },
                    fontFamily: {
                        mono: ['Fira Code', 'Consolas', 'Monaco', 'monospace'],
                        sans: ['Inter', 'Rubik', 'sans-serif']
                    }
                }
            }
        } };
