module.exports = {
    apps: [
        {
            name: "bot",
            script: "./index.js",

            instances: 1,
            exec_mode: "fork",

            autorestart: true,
            watch: false,

            max_memory_restart: "200M",

            env: {
                NODE_ENV: "production",
            },

            time: true,
        },
    ],
};