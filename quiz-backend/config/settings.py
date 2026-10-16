"""general-quiz · Django 配置（独立后端）。

设计原则（写给以后接手的人）：
1. 所有会因环境而变的东西（密钥、域名、数据库）都从环境变量读。
2. 留有方便本地开发的默认值；生产用 `QUIZ_ENV=prod` 打开安全开关。
3. 静态文件与前端构建产物落在 BASE_DIR 下，nginx 反代或 config/spa.py 直接发。

⚠️ **AI 功能默认禁用**：见 ``apps/quizgen/llm.py`` 模块注释。
   把 ``QUIZ_LLM_API_KEY`` 配上环境变量即可启用 AI 接口（补解析 / 出题 / 教练 / 诊断 / 知识图谱 / 任务回路）。
"""

from pathlib import Path
import os

BASE_DIR = Path(__file__).resolve().parent.parent

# ---------------------------------------------------------------------------
# 环境判定
# ---------------------------------------------------------------------------
ENV = os.environ.get("QUIZ_ENV", "dev").lower()
IS_PROD = ENV == "prod"


def env_list(name: str, default: str = "") -> list[str]:
    """把逗号分隔的环境变量切成列表，自动去空白与空项。"""
    raw = os.environ.get(name, default)
    return [item.strip() for item in raw.split(",") if item.strip()]


# ---------------------------------------------------------------------------
# 安全
# ---------------------------------------------------------------------------
# ⚠️ 生产一定要设 QUIZ_SECRET_KEY！默认那串仅供本地开发。
SECRET_KEY = os.environ.get(
    "QUIZ_SECRET_KEY",
    "django-insecure-dev-only-change-me-in-production-7f3k9q2m4x8v1b6n0p5wz3tj",
)
DEBUG = os.environ.get("QUIZ_DEBUG", "0" if IS_PROD else "1") == "1"

ALLOWED_HOSTS = env_list(
    "QUIZ_ALLOWED_HOSTS",
    "127.0.0.1,localhost",
)

# CSRF 信任来源：Django 是拿字符串精确比对的，浏览器发什么就写什么。
# 本地开发用 vite 转发 http://localhost:5273，配生产域名时把 https://your.domain 也加进去。
CSRF_TRUSTED_ORIGINS = env_list(
    "QUIZ_CSRF_TRUSTED_ORIGINS",
    ",".join([
        "http://127.0.0.1:8000", "http://localhost:8000",
        "http://127.0.0.1:5273", "http://localhost:5273",
        "http://127.0.0.1:8080", "http://localhost:8080",
    ]),
)

# nginx / 反代在前面时让 Django 知道原始请求是 https
SECURE_PROXY_SSL_HEADER = ("HTTP_X_FORWARDED_PROTO", "https")

if IS_PROD:
    SECURE_SSL_REDIRECT = True
    SESSION_COOKIE_SECURE = True
    CSRF_COOKIE_SECURE = True
    SECURE_HSTS_SECONDS = 31536000
    SECURE_HSTS_INCLUDE_SUBDOMAINS = True
    SECURE_HSTS_PRELOAD = False
    SECURE_CONTENT_TYPE_NOSNIFF = True
    SECURE_REFERRER_POLICY = "strict-origin-when-cross-origin"
    X_FRAME_OPTIONS = "SAMEORIGIN"

SESSION_COOKIE_SAMESITE = "Lax"
CSRF_COOKIE_SAMESITE = "Lax"
DATA_UPLOAD_MAX_MEMORY_SIZE = 12 * 1024 * 1024
FILE_UPLOAD_MAX_MEMORY_SIZE = 4 * 1024 * 1024

# ---------------------------------------------------------------------------
# 应用
# ---------------------------------------------------------------------------
INSTALLED_APPS = [
    "django.contrib.admin",
    "django.contrib.auth",
    "django.contrib.contenttypes",
    "django.contrib.sessions",
    "django.contrib.messages",
    "django.contrib.staticfiles",
    # 刷题站：账号 + 题库解析 + 进度同步 + Java 沙箱 + AI 接口（默认禁用）
    "apps.quizgen",
]

MIDDLEWARE = [
    "django.middleware.security.SecurityMiddleware",
    "django.contrib.sessions.middleware.SessionMiddleware",
    "django.middleware.common.CommonMiddleware",
    "django.middleware.csrf.CsrfViewMiddleware",
    "django.contrib.auth.middleware.AuthenticationMiddleware",
    "django.contrib.messages.middleware.MessageMiddleware",
    "django.middleware.clickjacking.XFrameOptionsMiddleware",
]

ROOT_URLCONF = "config.urls"
WSGI_APPLICATION = "config.wsgi.application"
ASGI_APPLICATION = "config.asgi.application"

TEMPLATES = [
    {
        "BACKEND": "django.template.backends.django.DjangoTemplates",
        "DIRS": [BASE_DIR / "templates"],
        "APP_DIRS": True,
        "OPTIONS": {
            "context_processors": [
                "django.template.context_processors.request",
                "django.contrib.auth.context_processors.auth",
                "django.contrib.messages.context_processors.messages",
            ],
        },
    },
]

# ---------------------------------------------------------------------------
# 数据库：默认 SQLite（单机自用足够），设 QUIZ_DB=postgres 切 PostgreSQL
# ---------------------------------------------------------------------------
if os.environ.get("QUIZ_DB", "sqlite").lower() in ("postgres", "postgresql"):
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.postgresql",
            "NAME": os.environ.get("QUIZ_PG_NAME", "quiz"),
            "USER": os.environ.get("QUIZ_PG_USER", "quiz"),
            "PASSWORD": os.environ.get("QUIZ_PG_PASSWORD", ""),
            "HOST": os.environ.get("QUIZ_PG_HOST", "127.0.0.1"),
            "PORT": os.environ.get("QUIZ_PG_PORT", "5432"),
            "CONN_MAX_AGE": 60,
        }
    }
else:
    _sqlite_path = Path(os.environ.get("QUIZ_SQLITE", BASE_DIR / "db.sqlite3"))
    _sqlite_path.parent.mkdir(parents=True, exist_ok=True)
    DATABASES = {
        "default": {
            "ENGINE": "django.db.backends.sqlite3",
            "NAME": _sqlite_path,
            "OPTIONS": {"timeout": 20},
        }
    }

DEFAULT_AUTO_FIELD = "django.db.models.BigAutoField"
# 用 Django 内置 auth.User；quizgen 不另开 user 表
# AUTH_USER_MODEL = "auth.User"   ← 默认就是它

AUTH_PASSWORD_VALIDATORS = [
    {"NAME": "django.contrib.auth.password_validation.UserAttributeSimilarityValidator"},
    {"NAME": "django.contrib.auth.password_validation.MinimumLengthValidator",
     "OPTIONS": {"min_length": 8}},
    {"NAME": "django.contrib.auth.password_validation.CommonPasswordValidator"},
    {"NAME": "django.contrib.auth.password_validation.NumericPasswordValidator"},
]

# ---------------------------------------------------------------------------
# 国际化
# ---------------------------------------------------------------------------
LANGUAGE_CODE = "zh-hans"
TIME_ZONE = "Asia/Shanghai"
USE_I18N = True
USE_TZ = True

# ---------------------------------------------------------------------------
# 静态
# ---------------------------------------------------------------------------
STATIC_URL = "/static/"
STATIC_ROOT = BASE_DIR / "staticfiles"

# 前端构建产物目录：开发用 vite dev；生产用 nginx 或 config/spa.py 直发。
QUIZ_FRONTEND_DIST = Path(
    os.environ.get("QUIZ_FRONTEND_DIST", BASE_DIR.parent / "quiz-frontend" / "dist")
)

# ---------------------------------------------------------------------------
# 刷题站（apps/quizgen）路径
# ---------------------------------------------------------------------------
# 这三个目录都允许通过环境变量重定向：
#   QUIZ_PARSER_PATH    PDF→题库的解析规则模块（仓库里的 tools/pdf_to_json.py）。
#                       模块把 PyMuPDF 做成了按需导入，没装也能用。
#   QUIZ_CACHE_DIR      AI 补解析的服务端缓存。同一道题只花一次。
#   QUIZ_JAVA_SANDBOX   Java 真跑沙箱（仓库里的 tools/java_sandbox.py），
#                       和解析规则一样**动态加载同一份文件**，不拷贝。
QUIZ_PARSER_PATH = Path(
    os.environ.get("QUIZ_PARSER_PATH", BASE_DIR / "tools" / "pdf_to_json.py")
)
QUIZ_CACHE_DIR = Path(
    os.environ.get("QUIZ_CACHE_DIR", BASE_DIR / ".quiz-cache")
)
QUIZ_JAVA_SANDBOX_PATH = Path(
    os.environ.get("QUIZ_JAVA_SANDBOX", BASE_DIR / "tools" / "java_sandbox.py")
)

# ---------------------------------------------------------------------------
# Java 真跑（默认关闭）
#
# ⚠️ QUIZ_JAVA_ENABLED **默认关闭**：
#   这个接口会**在服务器上执行用户提交的任意 Java 代码**（真 JVM，不是我们自己写的沙箱运行时）。
#   tools/java_sandbox.py 用 bubblewrap 做了隔离（实测：网络不通、/home 读不到、
#   环境变量不继承、写超大文件被掐），但那是"私有/内网自用"级别的隔离，**不是多租户级别**。
#   公网可达的部署**别开**这条；只在内网或自用场景下打开。
#
#   QUIZ_JAVA_ENABLED=1         启用 Java 真跑接口
#   QUIZ_JAVA_TIMEOUT=20        单次编译+运行墙钟上限（秒）
#   QUIZ_JAVA_MEMORY_MB=128     JVM 堆上限（用 -Xmx，**不要**用 ulimit -v，那会把 JVM 打死）
QUIZ_JAVA_ENABLED = os.environ.get("QUIZ_JAVA_ENABLED", "").strip().lower() in (
    "1", "true", "yes", "on"
)
QUIZ_JAVA_TIMEOUT = float(os.environ.get("QUIZ_JAVA_TIMEOUT", "20"))
QUIZ_JAVA_MEMORY_MB = int(os.environ.get("QUIZ_JAVA_MEMORY_MB", "128"))

# ---------------------------------------------------------------------------
# 提权（"站内自己解锁 Java"）
#
# 设计要点：**敲键序列只负责"把密码框叫出来"，它不是安全边界。**
#   前端 bundle 是公开可读的，翻一遍 JS 就能知道敲什么键，所以真正的门只有一道：
#   **服务端拿密码换一个短期签名 token**。
#   密码只从环境变量读（不进代码库、不回传前端）。
#
#   QUIZ_ELEVATE_PASSWORD     提权密码。**不设 = 提权功能不存在 = Java 永远 403**
#   QUIZ_ELEVATE_TTL          一次提权有效期（秒），默认 30 分钟
#   QUIZ_ELEVATE_TRIES        每 IP 每窗口允许试几次密码（默认 8 次 / 10 分钟）
QUIZ_ELEVATE_PASSWORD = os.environ.get("QUIZ_ELEVATE_PASSWORD", "")
QUIZ_ELEVATE_TTL = int(os.environ.get("QUIZ_ELEVATE_TTL", "1800"))
QUIZ_ELEVATE_TRIES = int(os.environ.get("QUIZ_ELEVATE_TRIES", "8"))

# ---------------------------------------------------------------------------
# 学生注册与登录限流（apps/quizgen.accounts）
# ---------------------------------------------------------------------------
# 注册档位：
#   QUIZ_SIGNUP_MODE=open     谁都能注册（默认）
#   QUIZ_SIGNUP_MODE=key      要邀请码（配 QUIZ_SIGNUP_KEY）
#   QUIZ_SIGNUP_MODE=closed   只能在 admin 里开号
QUIZ_SIGNUP_MODE = (
    os.environ.get("QUIZ_SIGNUP_MODE", "open").strip().lower() or "open"
)
QUIZ_SIGNUP_KEY = os.environ.get("QUIZ_SIGNUP_KEY", "").strip()

QUIZ_LOGIN_PER_IP = int(os.environ.get("QUIZ_LOGIN_PER_IP", "20"))
QUIZ_LOGIN_PER_NAME = int(os.environ.get("QUIZ_LOGIN_PER_NAME", "8"))
QUIZ_SIGNUP_PER_IP = int(os.environ.get("QUIZ_SIGNUP_PER_IP", "5"))
QUIZ_AUTH_WINDOW = int(os.environ.get("QUIZ_AUTH_WINDOW", "600"))

# ---------------------------------------------------------------------------
# 日志
# ---------------------------------------------------------------------------
LOG_DIR = Path(os.environ.get("QUIZ_LOG_DIR", BASE_DIR / "logs"))
LOG_DIR.mkdir(parents=True, exist_ok=True)

LOGGING = {
    "version": 1,
    "disable_existing_loggers": False,
    "formatters": {
        "standard": {"format": "%(asctime)s %(levelname)s %(name)s %(message)s"},
    },
    "handlers": {
        "console": {"class": "logging.StreamHandler", "formatter": "standard"},
        "file": {
            "class": "logging.handlers.TimedRotatingFileHandler",
            "filename": str(LOG_DIR / "quiz.log"),
            "when": "midnight",
            "backupCount": 14,
            "encoding": "utf-8",
            "formatter": "standard",
        },
    },
    "root": {"handlers": ["console", "file"], "level": "INFO"},
    "loggers": {
        "django.request": {"handlers": ["console", "file"], "level": "INFO", "propagate": False},
    },
}
