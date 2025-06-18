require("dotenv").config(); 
const express = require("express");
const mysql = require("mysql2/promise");
const cors = require("cors");
const path = require("path");

// Инициализация Express приложения
const app = express();
// Используем порт из переменных окружения или 3000 по умолчанию
const PORT = process.env.PORT || 3000;
// Ограничение размера тела запроса и обработка JSON
app.use(express.json({ limit: "1mb" }));

app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return errorResponse(res, "Неверный формат JSON в теле запроса.", 400);
  }
  next();
});

app.use(cors());
app.use(express.static(path.join(__dirname, "public")));

//Конфигурация и подключение к Базе Данных

const dbConfig = {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  charset: "utf8mb4",
  connectionLimit: 10,
  waitForConnections: true,
  queueLimit: 0,
};

const pool = mysql.createPool(dbConfig);


const validateUser = (userData, isUpdate = false) => {
  const errors = [];
  const requiredFields = ["full_name", "role", "efficiency"];

  if (!isUpdate) {
    for (const field of requiredFields) {
      if (userData[field] === undefined || userData[field] === null) {
        errors.push(`Поле '${field}' обязательно.`);
      }
    }
    if (errors.length > 0) return errors;
  }

  if (userData.hasOwnProperty("full_name")) {
    if (
      typeof userData.full_name !== "string" ||
      userData.full_name.trim().length === 0
    ) {
      errors.push("Поле 'full_name' должно быть непустой строкой.");
    } else if (userData.full_name.length > 255) {
      errors.push("Поле 'full_name' слишком длинное (макс. 255 символов).");
    }
  }

  if (userData.hasOwnProperty("role")) {
    if (
      typeof userData.role !== "string" ||
      userData.role.trim().length === 0
    ) {
      errors.push("Поле 'role' должно быть непустой строкой.");
    } else if (userData.role.length > 255) {
      errors.push("Поле 'role' слишком длинное (макс. 255 символов).");
    }
  }

  if (userData.hasOwnProperty("efficiency")) {
    if (!Number.isInteger(userData.efficiency)) {
      errors.push("Поле 'efficiency' должно быть целым числом.");
    } else if (userData.efficiency < 0 || userData.efficiency > 100) {
      errors.push("Поле 'efficiency' должно быть в диапазоне от 0 до 100.");
    }
  }

  return errors;
};

const validateId = (id) => {
  const numId = parseInt(id, 10);
  if (isNaN(numId) || numId <= 0 || numId > 2147483647) {
    return false;
  }
  return numId;
};

const errorResponse = (res, message, statusCode = 400) => {
  return res.status(statusCode).json({
    success: false,
    result: {
      error: message,
    },
  });
};

//Endpoints

app.post("/create", async (req, res) => {
  try {
    const userData = req.body;
    const errors = validateUser(userData);
    if (errors.length > 0) {
      return errorResponse(res, errors.join(", "), 400);
    }

    const cleanData = {
      full_name: userData.full_name.trim(),
      role: userData.role.trim(),
      efficiency: userData.efficiency,
    };

    const [result] = await pool.execute(
      "INSERT INTO users (full_name, role, efficiency) VALUES (?, ?, ?)",
      [cleanData.full_name, cleanData.role, cleanData.efficiency]
    );

    res.status(201).json({
      success: true,
      result: { id: result.insertId },
    });
  } catch (error) {
    console.error("Ошибка при создании пользователя:", error);
    if (error.code === "ER_DUP_ENTRY") {
      return errorResponse(
        res,
        "Пользователь с таким именем уже существует.",
        409
      );
    }
    return errorResponse(res, "Внутренняя ошибка сервера.", 500);
  }
});

app.get("/get/:id?", async (req, res) => {
  try {
    const { id } = req.params;
    const { role, full_name, efficiency } = req.query;

    let query = "SELECT id, full_name, role, efficiency FROM users";
    const params = [];
    const conditions = [];

    if (id) {
      const validId = validateId(id);
      if (!validId) return errorResponse(res, "Неверный ID пользователя.", 400);
      conditions.push("id = ?");
      params.push(validId);
    }

    if (role) {
      conditions.push("role = ?");
      params.push(role);
    }
    if (full_name) {
      conditions.push("full_name LIKE ?");
      params.push(`%${full_name}%`);
    }
    if (efficiency !== undefined) {
      const efficiencyNum = parseInt(efficiency, 10);
      if (isNaN(efficiencyNum))
        return errorResponse(
          res,
          "Неверное значение для фильтра efficiency.",
          400
        );
      conditions.push("efficiency = ?");
      params.push(efficiencyNum);
    }

    if (conditions.length > 0) {
      query += " WHERE " + conditions.join(" AND ");
    }
    query += " ORDER BY id";

    const [rows] = await pool.execute(query, params);

    if (id && rows.length === 0) {
      return errorResponse(res, `Пользователь с ID ${id} не найден.`, 404);
    }

    res.json({ success: true, result: { users: rows } });
  } catch (error) {
    console.error("Ошибка при получении пользователей:", error);
    return errorResponse(res, "Внутренняя ошибка сервера.", 500);
  }
});

app.patch("/update/:id", async (req, res) => {
  try {
    const validId = validateId(req.params.id);
    if (!validId) return errorResponse(res, "Неверный ID пользователя.", 400);

    if (Object.keys(req.body).length === 0) {
      return errorResponse(res, "Тело запроса не должно быть пустым.", 400);
    }

    const errors = validateUser(req.body, true);
    if (errors.length > 0) {
      return errorResponse(res, errors.join(", "), 400);
    }

    const connection = await pool.getConnection();
    try {
      await connection.beginTransaction();

      const [existingUser] = await connection.execute(
        "SELECT id FROM users WHERE id = ?",
        [validId]
      );
      if (existingUser.length === 0) {
        connection.rollback();
        return errorResponse(
          res,
          `Пользователь с ID ${validId} не найден.`,
          404
        );
      }

      const updateFields = Object.entries(req.body)
        .map(([key]) => `${key} = ?`)
        .join(", ");
      const updateValues = Object.values(req.body).map((val) =>
        typeof val === "string" ? val.trim() : val
      );

      await connection.execute(
        `UPDATE users SET ${updateFields} WHERE id = ?`,
        [...updateValues, validId]
      );

      const [updatedUser] = await connection.execute(
        "SELECT id, full_name, role, efficiency FROM users WHERE id = ?",
        [validId]
      );

      await connection.commit();

      res.json({ success: true, result: updatedUser[0] });
    } catch (err) {
      await connection.rollback();
      throw err;
    } finally {
      connection.release();
    }
  } catch (error) {
    console.error("Ошибка при обновлении пользователя:", error);
    if (error.code === "ER_DUP_ENTRY") {
      return errorResponse(
        res,
        "Пользователь с таким именем уже существует.",
        409
      );
    }
    return errorResponse(res, "Внутренняя ошибка сервера.", 500);
  }
});

app.delete("/delete/:id?", async (req, res) => {
  try {
    const { id } = req.params;

    if (id) {
      const validId = validateId(id);
      if (!validId) return errorResponse(res, "Неверный ID пользователя.", 400);

      const [user] = await pool.execute(
        "SELECT id, full_name, role, efficiency FROM users WHERE id = ?",
        [validId]
      );
      if (user.length === 0) {
        return errorResponse(
          res,
          `Пользователь с ID ${validId} не найден.`,
          404
        );
      }

      await pool.execute("DELETE FROM users WHERE id = ?", [validId]);
      res.json({ success: true, result: user[0] });
    } else {
      await pool.execute("TRUNCATE TABLE users");
      res.json({ success: true });
    }
  } catch (error) {
    console.error("Ошибка при удалении:", error);
    return errorResponse(res, "Внутренняя ошибка сервера.", 500);
  }
});

//Служебные маршруты

app.post("/setup", async (req, res) => {
  try {
    const createTableQuery = `
      CREATE TABLE IF NOT EXISTS users (
        id INT AUTO_INCREMENT PRIMARY KEY,
        full_name VARCHAR(255) NOT NULL,
        role VARCHAR(255) NOT NULL,
        efficiency INT NOT NULL,
        created_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
        UNIQUE KEY full_name_unique (full_name)
      );
    `;
    await pool.execute(createTableQuery);
    res.json({
      success: true,
      message: "Таблица 'users' успешно создана или уже существует.",
    });
  } catch (error) {
    console.error("Ошибка при настройке таблицы:", error);
    errorResponse(res, `Ошибка при настройке таблицы: ${error.message}`, 500);
  }
});

app.get("/health", async (req, res) => {
  try {
    await pool.query("SELECT 1");
    res.json({ status: "OK", database: "Connected" });
  } catch (error) {
    res.status(500).json({ status: "Error", database: "Disconnected" });
  }
});

//Обработка ошибок и запуск сервера

app.use((req, res, next) => {
  errorResponse(res, `Ресурс не найден: ${req.method} ${req.originalUrl}`, 404);
});

app.use((error, req, res, next) => {
  console.error("Необработанная ошибка:", error);
  errorResponse(res, "Внутренняя ошибка сервера.", 500);
});

const gracefulShutdown = async () => {
  console.log("Получен сигнал о завершении, закрываю пул соединений...");
  await pool.end();
  console.log("Пул соединений закрыт.");
  process.exit(0);
};

process.on("SIGTERM", gracefulShutdown);
process.on("SIGINT", gracefulShutdown);

if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`Сервер запущен на порту ${PORT}`);
  });
}

module.exports = app;
