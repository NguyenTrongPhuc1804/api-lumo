module.exports = {
    apps: [
        {
            name: "api-lumo",
            script: "./src/index.js",
            interpreter: "/home/admin/.nvm/versions/node/v22.23.4/bin/node",
            // Doc bien moi truong tu file .env (Node 22 khong tu doc)
            node_args: "--env-file=.env",
            instances: 1,
            env: {
                NODE_ENV: "production",
            },
            error_file: "./logs/err.log",
            out_file: "./logs/out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
            merge_logs: true,
        },
    ],
};
