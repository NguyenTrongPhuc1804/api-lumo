module.exports = {
    apps: [
        {
            name: "api-lumo",
            // cwd de PM2 luon chay app trong thu muc nay, khong phu thuoc thu muc goi pm2
            cwd: "/home/api-lumo",
            script: "./src/index.js",
            // Doc .env bang duong dan tuong doi (cwd = /home/api-lumo) de doi thu muc chi sua 1 cho
            node_args: "--env-file=.env",
            instances: 1,
            env: {
                NODE_ENV: "production",
            },
            error_file: "/home/api-lumo/logs/err.log",
            out_file: "/home/api-lumo/logs/out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
            merge_logs: true,
        },
    ],
};
