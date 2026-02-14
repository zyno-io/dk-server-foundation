process.env = {
    OTEL_EXPORTER_OTLP_ENDPOINT: 'http://localhost:4318',
    APP_ENV: 'development',
    MYSQL_HOST: 'localhost',
    MYSQL_PORT: '3306',
    MYSQL_USER: 'root',
    MYSQL_PASSWORD_SECRET: 'secret',
    MYSQL_DATABASE: 'default',
    REDIS_HOST: 'localhost',
    REDIS_PREFIX: 'dksfsample',
    ...process.env
};

// eslint-disable-next-line @typescript-eslint/no-require-imports
require('../src/telemetry/otel/index').init();
// eslint-disable-next-line @typescript-eslint/no-require-imports
require('./sample');
