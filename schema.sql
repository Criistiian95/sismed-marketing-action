CREATE TABLE IF NOT EXISTS prospectos_sismed (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
  nombre_consultorio VARCHAR(200) NOT NULL,
  ciudad VARCHAR(120) NULL,
  contacto_nombre VARCHAR(160) NULL,
  canal VARCHAR(30) NULL,
  contacto VARCHAR(255) NULL,
  fuente VARCHAR(255) NULL,
  estado VARCHAR(30) NOT NULL DEFAULT 'nuevo',
  notas TEXT NULL,
  proxima_accion VARCHAR(255) NULL,
  fecha_proxima_accion DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX idx_estado (estado),
  INDEX idx_fecha_proxima_accion (fecha_proxima_accion)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
