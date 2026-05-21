// Hardcoded database credentials
export const db = {
  host: 'production-db.internal.company.com',
  port: 5432,
  username: 'app_user',
  password: 'Pr0d_P@ssw0rd_2024!',
  database: 'production_app',
  connectionString: 'postgres://app_user:Pr0d_P@ssw0rd_2024!@production-db.internal.company.com:5432/production_app',
  query: async (sql: string) => ({ rows: [] }),
};

// SSL disabled for "convenience"
export const dbConfig = {
  ssl: false,
  rejectUnauthorized: false,
};
