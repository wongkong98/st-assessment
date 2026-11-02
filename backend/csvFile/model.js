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
    async getAll() {
        const page = req.query.page || 10;
        const limit = req.query.limit || 0;
        const offset = (page - 1) * limit;
        debugger
        const countQuery = 'SELECT COUNT(*) AS total FROM csv_file';
        const [countResult] = await db.query(countQuery);
        const totalItems = parseInt(countResult[0].total, 10);

        const [files] = await db.query('SELECT * FROM csv_file ORDER BY id ASC LIMIT ? OFFSET ?', [limit, offset]);

        const totalPages = Math.ceil(totalItems / limit);

        res.json({
            metadata: {
                totalItems,
                totalPages,
                currentPage: page,
                pageSize: limit,
                hasNextPage: page < totalPages,
                hasPreviousPage: page > 1
            },
            data: files
        });
    }
};

module.exports = CsvFile;