const db = require('../utils/db');

const CsvFile = {
    async findById(id) {
        const queryText = 'SELECT * FROM csv_file WHERE id = $1';
        const { rows } = await db.query(queryText, [id]);
        return rows[0] || null;
    },
    async create( name, path, date_uploaded) {
        const queryText = 'INSERT INTO csv_file(name, path, date_uploaded) VALUES($1, $2, $3) RETURNING *';
        const values = [name, path, date_uploaded];
        const { rows } = await db.query(queryText, values);
        return rows[0];
    },
    async getAll(page = 1, limit = 10, offset = 0) {
        const countQuery = 'SELECT COUNT(*) AS total FROM csv_file';
        const countRes = await db.query(countQuery);
        const totalItems = parseInt(countRes.rows[0].total, 10);

        const res1 = await db.query('SELECT * FROM csv_file ORDER BY id ASC LIMIT $1 OFFSET $2', [limit, offset]);
        
        const totalPages = Math.ceil(totalItems / limit);

        return {
            metadata: {
                totalItems,
                totalPages,
                currentPage: page,
                pageSize: limit,
                hasNextPage: page < totalPages,
                hasPreviousPage: page > 1
            },
            data: res1.rows
        };
    }
};

module.exports = CsvFile;