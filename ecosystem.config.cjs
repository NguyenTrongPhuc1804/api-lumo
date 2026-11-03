module.exports = {
    apps: [
        {
            name: "api-lumo",
            // cwd de PM2 luon chay app trong thu muc nay, khong phu thuoc thu muc goi pm2
            cwd: "/home/admin/api-lumo",
            script: "./src/index.js",
            // Duong dan tuyet doi toi .env, tranh loi ".env: not found"
            node_args: "--env-file=/home/admin/api-lumo/.env",
            instances: 1,
            env: {
                NODE_ENV: "production",
            },
            error_file: "/home/admin/api-lumo/logs/err.log",
            out_file: "/home/admin/api-lumo/logs/out.log",
            log_date_format: "YYYY-MM-DD HH:mm:ss Z",
            merge_logs: true,
        },
    ],
};
