process.env = {
    APP_ENV: 'development',
    MYSQL_HOST: 'localhost',
    MYSQL_PORT: '3306',
    MYSQL_USER: 'root',
    MYSQL_PASSWORD_SECRET: 'secret',
    MYSQL_DATABASE: 'dksf_demo',
    REDIS_HOST: 'localhost',
    REDIS_PREFIX: 'dksfdemo',
    ...process.env
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
const mariadb = require('mariadb');

async function ensureDatabase() {
    const conn = await mariadb.createConnection({
        host: process.env.MYSQL_HOST,
        port: Number(process.env.MYSQL_PORT),
        user: process.env.MYSQL_USER,
        password: process.env.MYSQL_PASSWORD_SECRET
    });
    await conn.query(`DROP DATABASE IF EXISTS \`${process.env.MYSQL_DATABASE}\``);
    await conn.query(`CREATE DATABASE \`${process.env.MYSQL_DATABASE}\``);
    await conn.end();
}

ensureDatabase().then(() => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    require('./demo');
});
