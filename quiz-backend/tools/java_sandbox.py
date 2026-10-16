#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
java_sandbox.py —— 在**板子上**真编译、真运行 Java（JavaWeb 代码题的判据）
============================================================================
为什么要它：
  Vue 的代码题能在**浏览器里**跑，因为那是我们自己手写的迷你运行时（vue-shim.js）。
  Java 不能在浏览器里跑，所以必须落到后端 —— 好在板子上已经有 OpenJDK 17，
  实测 **javac 0.56s / java 0.15s**，按下「运行」等一秒不到，够交互。

  JavaWeb 教材（黑马/尚硅谷那一类）的例子几乎全是 Servlet / JSP / JDBC，
  **光有 JDK 一个都编译不过**（没有 javax.servlet / jakarta.servlet 这些包）。
  所以这里和迷你 Vue 一个思路：手写一份**迷你 Servlet API**，
  让教材片段能编译、能"发一次请求看到响应"。

  和迷你 Vue 一样，它**不是 Tomcat**，是刻意做小的：
  只覆盖教材示例用到的那点（getParameter / getWriter / getSession / Cookie / ServletContext），
  没有过滤器链、没有 JSP 编译、没有连接池。界面必须把这句话说清楚。

安全（这条别含糊）：
  跑的是**真 JVM + 用户给的源码**（不像 Vue 跑的是我们自己的解释器），所以必须隔离。
  板子上没有 docker，但有 **bubblewrap**（实测 0.11.1 可用）：

      bwrap --unshare-all  → 网络命名空间（实测：Java 连 1.1.1.1:80 → SocketException）
                            + PID / IPC / UTS / user 隔离
      只 ro-bind /usr /lib /etc，**不 bind /home** → 读不到板子上的密钥和 .cloudflared

  实测对照（aarch64 Linux 板子）：
      无隔离：能读 /etc/passwd、能连外网
      bwrap  ：网络被挡、/home 不可见

  剩下的风险（必须原样告诉用户，别吹成"绝对安全"）：
    · /etc 是**只读**挂进去的（Java 要读自己的配置），所以 /etc 下的**可读文件**看得见
    · 没有 CPU 配额，只有墙钟超时 + RLIMIT_CPU；超了就 kill
    · 这是"私有 / 内网自用"级别的隔离，不是多租户级别的
    · 所以后端默认**不开**（要显式打开开关），别把它暴露到公网

⚠️ 三个实测踩到的坑（都是会白查半天的）：
  1. `ulimit -v`（RLIMIT_AS）限内存会**直接把 JVM 打死**：
     "Could not reserve enough space for 251904KB object heap"
     —— JVM 启动时要预留一大片**虚拟**地址空间。限内存只能用 `-Xmx`。
  2. bwrap 里 `/bin` 是个指向 `usr/bin` 的**软链接**，只 bind /usr 的话
     `/bin/echo` 会报 "No such file or directory"。沙箱内一律用 `/usr/bin/...` 全路径。
  3. 中文：javac 不加 `-encoding UTF-8`，源码里的中文注释/字符串在部分环境直接报错；
     JVM 侧还要 LANG + `-Dfile.encoding=UTF-8`，否则 stdout 打出 `?`。
     （rexec.py 当年也栽在 GBK 控制台上，同一个坑的两个面。）
  4. **换行符跨平台不一样**：Windows 上 `println` 输出 CRLF（`\r\n`），板子上是 LF。
     所以判"期望输出"之前**必须先归一化换行**（前端 core/code.js 的 normalizeOutput
     本来就干这个）—— 否则同一段代码在开发机上过、在板子上判错，而看着毫无差别。
     这条是实测：本机自检输出里带 `\r\n`，板子上是 `\n`。

用法：
    python quiz/tools/java_sandbox.py --selftest
    python quiz/tools/java_sandbox.py --file Demo.java            # 编译并运行
    python quiz/tools/java_sandbox.py --file MyServlet.java --param name=张三
"""
from __future__ import annotations

import argparse
import locale
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time
from pathlib import Path

# --------------------------------------------------------------------------
# 1. 找 JDK：优先环境变量，其次 PATH，最后几个常见位置
# --------------------------------------------------------------------------

_CANDIDATE_BINS = (
    "/usr/lib/jvm/java-17-openjdk-arm64/bin",   # 板子上的实测路径
    "/usr/lib/jvm/default-java/bin",
    "/usr/lib/jvm/java-17-openjdk-amd64/bin",
)


def _exe(name: str) -> str | None:
    suffix = ".exe" if os.name == "nt" else ""
    home = os.environ.get("QUIZ_JAVA_HOME") or os.environ.get("JAVA_HOME")
    if home:
        cand = Path(home) / "bin" / f"{name}{suffix}"
        if cand.exists():
            return str(cand)
    found = shutil.which(name)
    if found:
        return found
    for d in _CANDIDATE_BINS:
        cand = Path(d) / f"{name}{suffix}"
        if cand.exists():
            return str(cand)
    return None


def java_paths() -> tuple[str | None, str | None]:
    """返回 (java, javac)。缺任何一个都算环境没准备好。"""
    return _exe("java"), _exe("javac")


# --------------------------------------------------------------------------
# 2. 迷你 Servlet API
#    一个包名写一遍，然后**用字符串替换生成另一套**（javax ↔ jakarta）——
#    教材两个时代都有，缺一套就会有一半例子编译不过。
# --------------------------------------------------------------------------

#: 占位符 %PKG%（比如 javax / jakarta）在 shim_sources() 里替换
_SHIM_TEMPLATES: dict[str, str] = {
    "%PKG%/servlet/RequestDispatcher.java": """package %PKG%.servlet;

import %PKG%.servlet.http.HttpServletRequest;
import %PKG%.servlet.http.HttpServletResponse;

import java.io.IOException;

/**
 * 迷你版 RequestDispatcher（**被真实教材逼出来的**）。
 *
 * 《Java Web 程序设计任务教程（第3版）》3.6 整节都在讲**请求转发 vs 重定向**，
 * 没有这个类，3.6.1 那三个例子（ForwardServlet01/02）一个都编译不过。
 *
 * ⚠️ 这里是**刻意做小的**，而且做了一个教学上更有用的选择：
 *    真实 forward 是"服务器内部把请求交给另一个资源"，浏览器地址栏不变、状态码还是 200；
 *    真实 sendRedirect 是"回一个 302 + Location，让浏览器**再发一次新请求**"。
 *    沙箱里没法真的再跑一个 Servlet，所以 forward 的做法是：
 *    **在响应体里写一行 `[forward] 目标路径`**，状态码保持 200。
 *    这样"转发还是重定向"这件事在**输出上就看得见**（302+Location vs 200+forward），
 *    正好是这个知识点要考的东西。界面必须说明这是简化，不是 Tomcat。
 */
public class RequestDispatcher {
    private final String path;

    public RequestDispatcher(String path) { this.path = path; }

    public String getPath() { return path; }

    /** 转发：状态码不变（默认 200），把"发生了什么"写进响应体 */
    public void forward(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.getWriter().println("[forward] " + path);
    }

    public void include(HttpServletRequest req, HttpServletResponse resp) throws IOException {
        resp.getWriter().println("[include] " + path);
    }
}
""",
    "%PKG%/servlet/ServletOutputStream.java": """package %PKG%.servlet;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.OutputStream;

/**
 * 迷你版 ServletOutputStream（**被真实教材逼出来的**）。
 *
 * 《Java Web 程序设计任务教程（第3版）》3.5.2 那张表（表3-13）讲的就是
 * `getWriter()` 与 `getOutputStream()` 两个方法，紧接着的例子（ResponseServlet02）
 * 就用 `getOutputStream()` 把一张图片写回客户端 —— 没有这个类，那一节的代码编译不过。
 *
 * 真实实现直接写 socket；这里写进 ByteArrayOutputStream，跑完由驱动报出来
 * （二进制报字节数，文本报内容）。
 */
public class ServletOutputStream extends OutputStream {
    private final ByteArrayOutputStream buf = new ByteArrayOutputStream();

    @Override
    public void write(int b) throws IOException { buf.write(b); }

    @Override
    public void write(byte[] b, int off, int len) throws IOException { buf.write(b, off, len); }

    @Override
    public void write(byte[] b) throws IOException { buf.write(b); }

    @Override
    public void flush() throws IOException { buf.flush(); }

    /* ---- 真实 API 里那几个 print/println 重载，教材会直接调 ---- */

    public void print(String s) throws IOException {
        if (s != null) { buf.write(s.getBytes("UTF-8")); }
    }

    public void println(String s) throws IOException {
        print(s);
        buf.write("\\n".getBytes("UTF-8"));
    }

    public void print(Object o) throws IOException { print(String.valueOf(o)); }

    public void println(Object o) throws IOException { println(String.valueOf(o)); }

    /* ---- 给测试驱动看的 ---- */

    public byte[] toByteArray() { return buf.toByteArray(); }

    public int size() { return buf.size(); }
}
""",
    "%PKG%/servlet/ServletException.java": """package %PKG%.servlet;

/** 迷你版：教材里的 catch (ServletException e) 要能编译。 */
public class ServletException extends Exception {
    public ServletException() { super(); }
    public ServletException(String message) { super(message); }
    public ServletException(String message, Throwable cause) { super(message, cause); }
    public ServletException(Throwable cause) { super(cause); }
}
""",
    "%PKG%/servlet/ServletContext.java": """package %PKG%.servlet;

import java.util.LinkedHashMap;
import java.util.Map;

/**
 * 迷你版 ServletContext：只做"整站共享的属性袋子"。
 * ⚠️ 真实 Tomcat 是**一个应用一个** context；这里一次运行也只有一个，够教材示例用。
 */
public class ServletContext {
    /** 真实 Tomcat 一个应用一个 context；沙箱一次运行也只有一个，所以做成共享单例。 */
    private static final ServletContext INSTANCE = new ServletContext();

    public static ServletContext shared() { return INSTANCE; }

    private final Map<String, Object> attrs = new LinkedHashMap<String, Object>();

    public Object getAttribute(String name) { return attrs.get(name); }

    public void setAttribute(String name, Object value) {
        if (value == null) { attrs.remove(name); } else { attrs.put(name, value); }
    }

    public void removeAttribute(String name) { attrs.remove(name); }

    /** 真实签名是走磁盘的真实路径；沙箱里统一映射到工作目录，别让教材示例读到板子上的文件。 */
    public String getRealPath(String path) { return "/work" + (path == null ? "" : path); }

    /** ServletContext 上也有 getRequestDispatcher（3.6.1 教材两种写法都用过）。 */
    public %PKG%.servlet.RequestDispatcher getRequestDispatcher(String path) {
        return new %PKG%.servlet.RequestDispatcher(path);
    }

    public String getInitParameter(String name) { return null; }

    public String getContextPath() { return "/app"; }
}
""",
    "%PKG%/servlet/http/HttpSession.java": """package %PKG%.servlet.http;

import java.util.LinkedHashMap;
import java.util.Map;

/** 迷你版 HttpSession：一次运行一个会话，id 递增。 */
public class HttpSession {
    private static int seq = 0;

    private final String id = "Q8B-SESSION-" + (++seq);
    private final Map<String, Object> attrs = new LinkedHashMap<String, Object>();
    private boolean valid = true;

    public String getId() { return id; }

    public Object getAttribute(String name) { return valid ? attrs.get(name) : null; }

    public void setAttribute(String name, Object value) {
        if (value == null) { attrs.remove(name); } else { attrs.put(name, value); }
    }

    public void removeAttribute(String name) { attrs.remove(name); }

    public void invalidate() { valid = false; attrs.clear(); }

    public boolean isValid() { return valid; }
}
""",
    "%PKG%/servlet/http/Cookie.java": """package %PKG%.servlet.http;

/** 迷你版 Cookie：只保留教材示例用到的几个字段。 */
public class Cookie {
    private final String name;
    private String value;
    private String path = "/";
    private int maxAge = -1;

    public Cookie(String name, String value) { this.name = name; this.value = value; }

    public String getName() { return name; }

    public String getValue() { return value; }

    public void setValue(String value) { this.value = value; }

    public String getPath() { return path; }

    public void setPath(String path) { this.path = path; }

    public int getMaxAge() { return maxAge; }

    public void setMaxAge(int maxAge) { this.maxAge = maxAge; }
}
""",
    "%PKG%/servlet/http/HttpServletRequest.java": """package %PKG%.servlet.http;

import %PKG%.servlet.ServletContext;

import java.util.ArrayList;
import java.util.Collections;
import java.util.Enumeration;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 迷你版 HttpServletRequest。
 * ⚠️ 真实 API 里这是**接口**，这里做成**类** —— 因为教材只会拿它声明变量，
 *    而做接口要额外写实现类，代码多一倍、收益为零。
 *    唯一的代价：如果有人写 `implements HttpServletRequest`（教材里不会有），会编译不过。
 */
public class HttpServletRequest {
    /** 真实 Tomcat 一个应用一个 context，这里一次运行一个，所以用共享单例。 */
    private static final ServletContext CONTEXT = ServletContext.shared();

    private final Map<String, String[]> params = new LinkedHashMap<String, String[]>();
    private final Map<String, Object> attrs = new LinkedHashMap<String, Object>();
    private final Map<String, String> headers = new LinkedHashMap<String, String>();
    private final List<Cookie> cookies = new ArrayList<Cookie>();

    private HttpSession session;
    private String method = "GET";
    private String uri = "/demo";
    private String contextPath = "/app";
    private String encoding = "UTF-8";

    /* ---- 下面 setXxx 是给"发一次请求"的测试驱动用的，不是 Servlet API ---- */

    public void setParameter(String name, String... values) { params.put(name, values); }

    public void setHeader(String name, String value) { headers.put(name, value); }

    public void addCookie(Cookie cookie) { cookies.add(cookie); }

    public void setMethod(String method) { this.method = method; }

    public void setRequestURI(String uri) { this.uri = uri; }

    /* ---- 下面才是教材会用到的 Servlet API ---- */

    public String getParameter(String name) {
        String[] v = params.get(name);
        return (v == null || v.length == 0) ? null : v[0];
    }

    public String[] getParameterValues(String name) { return params.get(name); }

    public Enumeration<String> getParameterNames() {
        return Collections.enumeration(params.keySet());
    }

    public String getHeader(String name) { return headers.get(name); }

    public Object getAttribute(String name) { return attrs.get(name); }

    public void setAttribute(String name, Object value) {
        if (value == null) { attrs.remove(name); } else { attrs.put(name, value); }
    }

    public void removeAttribute(String name) { attrs.remove(name); }

    public HttpSession getSession() { return getSession(true); }

    public HttpSession getSession(boolean create) {
        if (session == null && create) { session = new HttpSession(); }
        return session;
    }

    public Cookie[] getCookies() {
        return cookies.isEmpty() ? null : cookies.toArray(new Cookie[0]);
    }

    public String getMethod() { return method; }

    public String getRequestURI() { return uri; }

    public String getContextPath() { return contextPath; }

    public String getServletPath() { return ""; }

    public String getQueryString() {
        StringBuilder sb = new StringBuilder();
        for (Map.Entry<String, String[]> e : params.entrySet()) {
            if (sb.length() > 0) { sb.append('&'); }
            sb.append(e.getKey()).append('=').append(e.getValue()[0]);
        }
        return sb.length() == 0 ? null : sb.toString();
    }

    public void setCharacterEncoding(String encoding) { this.encoding = encoding; }

    public String getCharacterEncoding() { return encoding; }

    public ServletContext getServletContext() { return CONTEXT; }

    /**
     * 迷你版 getRequestDispatcher（3.6.1 请求转发要用）。
     * 真实 API 里 request 和 ServletContext 上都有这个方法，这里都有。
     */
    public %PKG%.servlet.RequestDispatcher getRequestDispatcher(String path) {
        return new %PKG%.servlet.RequestDispatcher(path);
    }

    public String getRemoteAddr() { return "127.0.0.1"; }

    public int getServerPort() { return 8080; }
}
""",
    "%PKG%/servlet/http/HttpServletResponse.java": """package %PKG%.servlet.http;

import java.io.PrintWriter;
import java.io.StringWriter;
import java.util.ArrayList;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;

/**
 * 迷你版 HttpServletResponse。
 * 真实响应是往 socket 里写字节；这里写进一个 StringWriter，
 * 跑完把 body 打出来 —— 这就是"发一次请求看到响应"。
 */
public class HttpServletResponse {
    private final StringWriter buffer = new StringWriter();
    private final PrintWriter writer = new PrintWriter(buffer);
    private %PKG%.servlet.ServletOutputStream binary;
    private final Map<String, String> headers = new LinkedHashMap<String, String>();
    private final List<Cookie> cookies = new ArrayList<Cookie>();

    private String contentType;
    private String encoding = "UTF-8";
    private String redirect;
    private int status = 200;

    public void setContentType(String contentType) { this.contentType = contentType; }

    public String getContentType() { return contentType; }

    public void setCharacterEncoding(String encoding) { this.encoding = encoding; }

    public String getCharacterEncoding() { return encoding; }

    public void setHeader(String name, String value) { headers.put(name, value); }

    public void addHeader(String name, String value) { headers.put(name, value); }

    public void addCookie(Cookie cookie) { cookies.add(cookie); }

    public void sendRedirect(String location) { this.redirect = location; this.status = 302; }

    public void setStatus(int status) { this.status = status; }

    public int getStatus() { return status; }

    public PrintWriter getWriter() { return writer; }

    /**
     * 迷你版 getOutputStream()（表3-13 的第二个方法）。
     * ⚠️ 真实 API 里 getWriter 和 getOutputStream **不能同时用**（会抛 IllegalStateException）。
     *    这里不做这个检查 —— 教材演示的是"两种任选其一"，加了反而容易让人以为写错了。
     */
    public %PKG%.servlet.ServletOutputStream getOutputStream() {
        if (binary == null) { binary = new %PKG%.servlet.ServletOutputStream(); }
        return binary;
    }

    /* ---- 下面几个是给测试驱动看的，不是 Servlet API ---- */

    public byte[] getBinaryBody() { return binary == null ? null : binary.toByteArray(); }

    public int getBinarySize() { return binary == null ? 0 : binary.size(); }

    public String getBody() { writer.flush(); return buffer.toString(); }

    public Map<String, String> getHeaders() { return headers; }

    public List<Cookie> getCookies() { return cookies; }

    public String getRedirect() { return redirect; }
}
""",
    "%PKG%/servlet/annotation/WebServlet.java": """package %PKG%.servlet.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/**
 * 迷你版 @WebServlet。
 *
 * ⚠️ 这个类是**被真实教材逼出来的**：《Java Web 程序设计任务教程（第3版）》
 * （黑马那套）里几乎每个 Servlet 例子都写着 `@WebServlet("/responseservlet02")`，
 * 没有这个注解，教材的代码**一条都编译不过**。
 * 沙箱里它只是个占位注解（不真的注册映射 —— 反正驱动是直接调 service 的）。
 */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
public @interface WebServlet {
    String[] value() default {};
    String[] urlPatterns() default {};
    String name() default "";
    int loadOnStartup() default -1;
}
""",
    "%PKG%/servlet/annotation/WebFilter.java": """package %PKG%.servlet.annotation;

import java.lang.annotation.ElementType;
import java.lang.annotation.Retention;
import java.lang.annotation.RetentionPolicy;
import java.lang.annotation.Target;

/** 迷你版 @WebFilter：同上，教材里的过滤器例子要用。沙箱里不真的挂过滤链。 */
@Retention(RetentionPolicy.RUNTIME)
@Target(ElementType.TYPE)
public @interface WebFilter {
    String[] value() default {};
    String[] urlPatterns() default {};
    String filterName() default "";
}
""",
    "%PKG%/servlet/http/HttpServlet.java": """package %PKG%.servlet.http;

import %PKG%.servlet.ServletException;

import java.io.IOException;

/**
 * 迷你版 HttpServlet。
 *
 * ⚠️ 访问修饰符**必须和真实 API 一致**（doGet/doPost/service 都是 protected）：
 *    教材里很常见 `protected void service(...)` 这种写法。
 *    如果这里把 service 写成 public，教材那份 protected 的覆盖就会变成
 *    "attempting to assign weaker access privileges" 编译错误 —— 白查半天。
 *    所以驱动类用的是**继承**（见 servlet_driver），而不是反射调用。
 */
public abstract class HttpServlet {

    protected void doGet(HttpServletRequest req, HttpServletResponse resp)
            throws ServletException, IOException {
        resp.setStatus(405);
    }

    protected void doPost(HttpServletRequest req, HttpServletResponse resp)
            throws ServletException, IOException {
        resp.setStatus(405);
    }

    protected void service(HttpServletRequest req, HttpServletResponse resp)
            throws ServletException, IOException {
        if ("POST".equalsIgnoreCase(req.getMethod())) {
            doPost(req, resp);
        } else {
            doGet(req, resp);
        }
    }

    public void init() throws ServletException { }

    public void destroy() { }

    public String getServletName() { return getClass().getName(); }

    /**
     * 迷你版 getServletContext()（**被真实教材逼出来的**）。
     * 教材里常常**不带限定符**直接写 `getServletContext().getRealPath(...)`
     * —— 那是从 GenericServlet 继承来的，所以必须挂在 HttpServlet 上，
     * 只放在 request 上编译不过（实测文件 3-14 就是这样）。
     */
    public %PKG%.servlet.ServletContext getServletContext() {
        return %PKG%.servlet.ServletContext.shared();
    }
}
""",
}


def shim_sources() -> dict[str, str]:
    """迷你 Servlet API 的全部源码：{相对路径: 源码}。

    一个包名写一遍，另一套用字符串替换生成 —— 教材横跨 javax / jakarta 两个时代，
    少一套就会有一半例子编译不过。
    """
    out: dict[str, str] = {}
    for pkg in ("javax", "jakarta"):
        for rel, src in _SHIM_TEMPLATES.items():
            out[rel.replace("%PKG%", pkg)] = src.replace("%PKG%", pkg)
    return out


# --------------------------------------------------------------------------
# 3. 测试驱动：让"教材里只写了 Servlet、没有 main"的片段能真跑
# --------------------------------------------------------------------------

_SERVLET_DECL = re.compile(r"class\s+([A-Za-z_$][\w$]*)\s+extends\s+HttpServlet\b")


def servlet_driver(source: str) -> tuple[str, str] | None:
    """如果这段代码是"一个继承 HttpServlet 的类"，生成一个驱动 + 返回 (类名, 驱动源码)。

    驱动用**继承**拿到 protected 的 service()：
        public class Q8bDriver extends 那个Servlet { ... service(req, resp) ... }
    —— 比反射干净，也不会因为访问修饰符对不上而编译失败。
    """
    m = _SERVLET_DECL.search(source)
    if not m:
        return None
    cls = m.group(1)
    # 用哪套包名？看源码 import 了哪个；都没有就按 javax（老教材）猜。
    pkg = "jakarta" if "jakarta.servlet" in source else "javax"
    driver = f"""import {pkg}.servlet.http.Cookie;
import {pkg}.servlet.http.HttpServletRequest;
import {pkg}.servlet.http.HttpServletResponse;
import {pkg}.servlet.http.HttpSession;

/**
 * 自动生成的测试驱动（不是教材内容）。
 * 作用：教材只写了 Servlet、没有 main，这里当一次"容器"，
 * 发一次请求，然后把响应按可断言的样子打印出来。
 */
public class Q8bDriver extends {cls} {{

    /** 子类身份才拿得到 protected 的 service() */
    private void fire(HttpServletRequest req, HttpServletResponse resp) throws Exception {{
        service(req, resp);
    }}

    public static void main(String[] args) throws Exception {{
        HttpServletRequest req = new HttpServletRequest();
        HttpServletResponse resp = new HttpServletResponse();
        for (String arg : args) {{
            if (arg.startsWith("--method=")) {{
                req.setMethod(arg.substring("--method=".length()));
            }} else if (arg.startsWith("--uri=")) {{
                req.setRequestURI(arg.substring("--uri=".length()));
            }} else if (arg.startsWith("--cookie=")) {{
                String kv = arg.substring("--cookie=".length());
                int i = kv.indexOf('=');
                if (i > 0) {{ req.addCookie(new Cookie(kv.substring(0, i), kv.substring(i + 1))); }}
            }} else {{
                int i = arg.indexOf('=');
                if (i > 0) {{
                    req.setParameter(arg.substring(0, i), arg.substring(i + 1));
                }}
            }}
        }}

        new Q8bDriver().fire(req, resp);

        resp.getWriter().flush();
        // ⚠️ 诊断信息走 **stderr**，正文走 **stdout**。
        //    因为判"跑出来的输出对不对"用的是 stdout —— 如果把 [status]/[content-type]
        //    也打到 stdout，那题库里的期望输出就得带上这堆驱动自己的噪声，
        //    学生看到的"期望输出"会变成一坨调试信息。分开放：正文才是判据，
        //    诊断仍然看得见（界面把 stderr 也显示出来，但不参与判定）。
        System.err.println("[status] " + resp.getStatus());
        System.err.println("[content-type] " + resp.getContentType());
        if (resp.getRedirect() != null) {{
            System.err.println("[redirect] " + resp.getRedirect());
        }}
        for (Cookie c : resp.getCookies()) {{
            System.err.println("[set-cookie] " + c.getName() + "=" + c.getValue()
                    + "; path=" + c.getPath() + "; maxAge=" + c.getMaxAge());
        }}
        HttpSession session = req.getSession(false);
        if (session != null) {{
            System.err.println("[session] " + session.getId());
        }}
        System.out.print(resp.getBody());
        if (!resp.getBody().endsWith("\\n")) {{ System.out.println(); }}
        // 二进制那条路（getOutputStream）：报字节数，能当文本看就把内容也打出来
        int bin = resp.getBinarySize();
        if (bin > 0) {{
            System.err.println("[binary-body] " + bin + " bytes");
            if (bin <= 4096) {{
                System.out.print(new String(resp.getBinaryBody(), "UTF-8"));
                System.out.println();
            }} else {{
                System.out.println("[二进制响应体 " + bin + " 字节，不打印内容]");
            }}
        }}
    }}
}}
"""
    return cls, driver


# --------------------------------------------------------------------------
# 4. 执行：编译 + 运行（带隔离和限额）
# --------------------------------------------------------------------------

#: 一次运行允许的最大源码体积（挡住"上传 10MB 源码"这种）
MAX_SOURCE_BYTES = 200 * 1024
#: 输出上限（超了截断，并标记 truncated）
MAX_OUTPUT_BYTES = 64 * 1024


def _sandbox_prefix(workdir: str) -> list[str] | None:
    """bwrap 前缀。没有 bwrap 就返回 None（调用方要如实把 sandbox 报成 'none'）。

    ⚠️ 只 bind /usr /lib /etc，**故意不 bind /home** ——
    用户家目录里的密钥、备份、配置文件都不应被沙箱代码读到。
    """
    if os.name == "nt":
        return None
    bwrap = shutil.which("bwrap")
    if not bwrap:
        return None
    prefix = [
        bwrap,
        "--unshare-all",        # 网络 / PID / IPC / UTS / user 命名空间全隔离
        "--die-with-parent",
        "--new-session",
        "--ro-bind", "/usr", "/usr",
        "--proc", "/proc",
        "--dev", "/dev",
        "--tmpfs", "/tmp",
    ]
    # /lib 在某些发行版是指向 usr/lib 的软链接，--ro-bind-try 对不存在的路径不报错
    for opt in ("/lib", "/lib64"):
        prefix += ["--ro-bind-try", opt, opt]
    # Java 要读自己 /etc 下的配置（security policy、jvm.cfg 之类）
    prefix += ["--ro-bind-try", "/etc", "/etc"]
    prefix += [
        # ⚠️ --clearenv：**别把板子后端的进程环境漏进沙箱** ——
        # 云端 key（DEEPSEEK_API_KEY 之类）就在里面，否则用户代码一句
        # System.getenv("...") 就把它读走了。下面只显式给必需的几个。
        "--clearenv",
        "--bind", workdir, workdir,
        "--chdir", workdir,
        "--setenv", "HOME", workdir,
        "--setenv", "TMPDIR", "/tmp",
        "--setenv", "PATH", "/usr/bin:/bin",
        "--setenv", "LANG", "C.UTF-8",
        "--setenv", "LC_ALL", "C.UTF-8",
    ]
    return prefix


def _limits():
    """给子进程设 rlimit。**只设 FSIZE / CPU。**

    ⚠️ **不要设 RLIMIT_NPROC**（实测踩到，代价不小）：跑后端的这个用户
    本来就有几百个线程 / 进程（ollama / nginx / uvicorn / 其他常驻服务都在跑）。
    RLIMIT_NPROC 数的是**这个用户全系统的进程数**，不是"这个沙箱的"，
    所以一旦设成比当前用量低的值（比如 256），连 `fork` 都过不去 ——
    症状是 `bwrap: Creating new namespace failed: Resource temporarily unavailable`
    （EAGAIN），看着像"命名空间被内核禁了"，其实是进程数限额。
    防"fork 炸弹"靠的是 bwrap 的 PID 命名空间 + `--die-with-parent`：
    外层 kill 掉 bwrap，内核会把那个命名空间里的东西一起收走。

    ⚠️ 也**绝不设 RLIMIT_AS**（= `ulimit -v`），它会把 JVM 直接打死
    （"Could not reserve enough space for object heap"）—— 限内存只能用 -Xmx。
    Windows 没有 preexec_fn，返回 None。
    """
    if os.name == "nt":
        return None

    def _apply() -> None:  # pragma: no cover - 只在 posix 子进程里跑
        import resource

        # 单个文件最大 8MB：挡住"程序疯狂写文件把磁盘写满"
        resource.setrlimit(resource.RLIMIT_FSIZE, (8 * 1024 * 1024, 8 * 1024 * 1024))
        # CPU 时间上限（不是墙钟）：死循环主要由外层 timeout 掐，这个兜底防"烧满 CPU"
        resource.setrlimit(resource.RLIMIT_CPU, (30, 30))

    return _apply


def _decode(raw: bytes) -> str:
    """解 javac / java 的输出。**编码要猜**，不能直接当 UTF-8。

    ⚠️ 实测：Windows 上 javac 按本地代码页（GBK）发诊断信息，直接按 UTF-8 解会得到
    `�Ҳ�������` —— 和当年 rexec.py 栽的"GBK 控制台把日志炸掉"是同一个坑。
    板子（Linux）上我们显式给了 LANG=C.UTF-8，所以先把 UTF-8 试死，再退回本地编码。

    顺带：javac 命令里加了 `-J-Dfile.encoding=UTF-8`，两边都保一道。
    """
    if not raw:
        return ""
    try:
        return raw.decode("utf-8")
    except UnicodeDecodeError:
        return raw.decode(locale.getpreferredencoding(False), "replace")


def _run(cmd: list[str], *, cwd: str, timeout: float, env: dict[str, str]) -> tuple[int, str, str, bool]:
    """跑一条命令，返回 (exit_code, stdout, stderr, timed_out)。"""
    try:
        proc = subprocess.run(
            cmd,
            cwd=cwd,
            env=env,
            stdin=subprocess.DEVNULL,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            preexec_fn=_limits(),
            check=False,
        )
    except subprocess.TimeoutExpired as exc:
        return -1, _decode(exc.stdout or b""), _decode(exc.stderr or b""), True
    except FileNotFoundError as exc:
        return -2, "", f"{exc}", False
    return proc.returncode, _decode(proc.stdout), _decode(proc.stderr), False


def run_java(
    sources: dict[str, str],
    *,
    main_class: str | None = None,
    params: list[str] | None = None,
    timeout: float = 15.0,
    memory_mb: int = 128,
    sandbox: str = "auto",
    use_shim: bool = True,
) -> dict:
    """编译并运行一份 Java 源码，返回**可断言**的结果。

    sources     {文件名: 源码}，例如 {"Demo.java": "public class Demo {...}"}
    main_class  入口类名；None 时依次尝试：
                ① 自动生成的 Servlet 驱动  ② 源码里唯一带 main 的类
    sandbox     'auto'（有 bwrap 就用）/ 'none'（明确不隔离，只给本机调试用）

    返回 {ok, phase, sandbox, output, stdout, stderr, exit_code, ms, compile_errors, truncated}
    phase: 'compile' | 'run' | 'ok' | 'timeout' | 'env'
    """
    java_bin, javac_bin = java_paths()
    if not java_bin or not javac_bin:
        return {
            "ok": False, "phase": "env", "sandbox": "none",
            "output": "", "stdout": [], "stderr": [],
            "exit_code": -2, "ms": 0, "truncated": False,
            "compile_errors": ["没找到 java / javac（设 QUIZ_JAVA_HOME 或装 JDK）"],
            "error": "java/javac 不可用",
        }

    total_bytes = sum(len(s.encode("utf-8")) for s in sources.values())
    if total_bytes > MAX_SOURCE_BYTES:
        return {
            "ok": False, "phase": "env", "sandbox": "none",
            "output": "", "stdout": [], "stderr": [], "exit_code": -2, "ms": 0,
            "truncated": False, "compile_errors": [f"源码太大（{total_bytes} > {MAX_SOURCE_BYTES} 字节）"],
            "error": "源码太大",
        }

    files = dict(sources)
    if use_shim:
        # 迷你 Servlet API 放进去；用户自己的同名文件优先（别把人家写的覆盖了）
        for rel, src in shim_sources().items():
            target = rel.split("/")[-1]
            if target not in files:
                files[rel] = src

    # 没有 main 的 Servlet 片段 → 生成驱动
    driver_class = None
    if main_class is None:
        for name, src in sources.items():
            made = servlet_driver(src)
            if made:
                cls, code = made
                files["Q8bDriver.java"] = code
                driver_class = "Q8bDriver"
                break
    if main_class is None and driver_class is None:
        # 兜底：源码里唯一带 main 的类
        for name, src in sources.items():
            m = re.search(r"class\s+([A-Za-z_$][\w$]*)[^{]*\{[^}]*?\bstatic\s+void\s+main\s*\(", src, re.S)
            if m:
                main_class = m.group(1)
                break
    entry = main_class or driver_class

    start = time.monotonic()
    work = tempfile.mkdtemp(prefix="quiz-java-")
    truncated = False
    try:
        for rel, src in files.items():
            path = Path(work) / rel
            path.parent.mkdir(parents=True, exist_ok=True)
            path.write_text(src, encoding="utf-8")

        env = {
            "PATH": "/usr/bin:/bin",
            "HOME": work,
            "LANG": "C.UTF-8",
            "LC_ALL": "C.UTF-8",
            "TMPDIR": "/tmp",
        }
        prefix = _sandbox_prefix(work) if sandbox != "none" else None
        used = "bwrap" if prefix else "none"
        if prefix is None:
            # 本机调试（没有 bwrap）：Windows 的 JVM 要 SystemRoot 才能起来，
            # 而沙箱那条路是 --clearenv + 显式 setenv，用不到这份。
            env = {**os.environ, **env}

        def wrap(cmd: list[str]) -> list[str]:
            return (prefix + cmd) if prefix else cmd

        # 内部一律用全路径：bwrap 里 /bin 是软链接，不会自己出现（坑 2）
        javac_in = javac_bin if not prefix else "/usr/bin/javac"
        java_in = java_bin if not prefix else "/usr/bin/java"

        # ---- 编译 ----
        src_files = [rel for rel in files if rel.endswith(".java")]
        code, out, err, timed = _run(
            wrap([javac_in, "-J-Dfile.encoding=UTF-8", "-encoding", "UTF-8", "-nowarn", "-d", work] + src_files),
            cwd=work, timeout=max(timeout, 30.0), env=env,
        )
        if timed or code != 0:
            errors = [l for l in (out + "\n" + err).splitlines() if l.strip()][:20]
            return {
                "ok": False, "phase": "timeout" if timed else "compile", "sandbox": used,
                "output": "", "stdout": [], "stderr": errors, "exit_code": code,
                "ms": int((time.monotonic() - start) * 1000), "truncated": False,
                "compile_errors": errors, "error": "编译失败",
            }

        if not entry:
            return {
                "ok": False, "phase": "env", "sandbox": used,
                "output": "", "stdout": [], "stderr": [], "exit_code": -2,
                "ms": int((time.monotonic() - start) * 1000), "truncated": False,
                "compile_errors": ["没找到入口类（既不是 Servlet，也没有 static void main）"],
                "error": "没有入口",
            }

        # ---- 运行 ----
        flags = [
            f"-Xmx{memory_mb}m",
            "-XX:+UseSerialGC",              # 小内存下更稳，启动也快
            "-Dfile.encoding=UTF-8",
            "-Dstdout.encoding=UTF-8",       # Java 18+ 认这个
            "-Dstderr.encoding=UTF-8",
            "-Dsun.stdout.encoding=UTF-8",   # Java 17 认这个（坑 3）
            "-Dsun.stderr.encoding=UTF-8",
        ]
        code, out, err, timed = _run(
            wrap([java_in] + flags + ["-cp", work, entry] + list(params or [])),
            cwd=work, timeout=timeout, env=env,
        )
        if len(out) > MAX_OUTPUT_BYTES:
            out = out[:MAX_OUTPUT_BYTES]
            truncated = True
        if len(err) > MAX_OUTPUT_BYTES:
            err = err[:MAX_OUTPUT_BYTES]
            truncated = True

        phase = "timeout" if timed else ("ok" if code == 0 else "run")
        return {
            "ok": (code == 0 and not timed),
            "phase": phase,
            "sandbox": used,
            "output": out,
            "stdout": out.splitlines(),
            "stderr": err.splitlines()[:40],
            "exit_code": code,
            "ms": int((time.monotonic() - start) * 1000),
            "truncated": truncated,
            "compile_errors": [],
            "error": "" if code == 0 else ("超时" if timed else "运行出错"),
        }
    finally:
        shutil.rmtree(work, ignore_errors=True)


# --------------------------------------------------------------------------
# 5. 自检
# --------------------------------------------------------------------------

HELLO = "public class Demo { public static void main(String[] a) { System.out.println(\"你好 Java\"); } }"

SERVLET = """import javax.servlet.*;
import javax.servlet.http.*;
import java.io.*;

public class HelloServlet extends HttpServlet {
    protected void doGet(HttpServletRequest req, HttpServletResponse resp)
            throws ServletException, IOException {
        resp.setContentType("text/html;charset=utf-8");
        PrintWriter out = resp.getWriter();
        String name = req.getParameter("name");
        out.println("<h1>你好, " + (name == null ? "游客" : name) + "</h1>");
        req.getSession().setAttribute("last", name);
    }
}
"""

SERVICE_OVERRIDE = """import javax.servlet.*;
import javax.servlet.http.*;
import java.io.*;

public class SvcServlet extends HttpServlet {
    // 教材里很常见的写法：覆盖 protected 的 service。
    // 如果迷你 API 把 service 写成 public，这里会编译失败（访问权限变弱）。
    protected void service(HttpServletRequest req, HttpServletResponse resp)
            throws ServletException, IOException {
        resp.getWriter().println("service 被覆盖了: " + req.getMethod());
    }
}
"""


def selftest() -> bool:
    passed = 0
    failed = 0

    def ok(cond: bool, label: str, extra: str = "") -> None:
        nonlocal passed, failed
        if cond:
            passed += 1
            print(f"  ✓ {label}")
        else:
            failed += 1
            print(f"  ✗ {label}" + (f"  →  {extra}" if extra else ""))

    print("\n═══ Java 沙箱自检 ═══")
    java_bin, javac_bin = java_paths()
    print(f"  java  = {java_bin}")
    print(f"  javac = {javac_bin}")
    if not java_bin or not javac_bin:
        print("  ❌ 没有 JDK，无法自检")
        return False

    # 1. 普通程序 + 中文输出
    r = run_java({"Demo.java": HELLO})
    ok(r["ok"], "真编译真运行一个普通程序", r.get("error", ""))
    ok("你好 Java" in r["output"], "★ 中文输出没被编码搞坏", repr(r["output"][:60]))
    ok(r["sandbox"] in ("bwrap", "none"), f"报告了隔离方式 = {r['sandbox']}")

    # 2. 编译错误要能看懂
    r = run_java({"Bad.java": "public class Bad { public static void main(String[] a) { int x = \"字符串\"; } }"})
    ok(not r["ok"] and r["phase"] == "compile", "编译错误 → phase=compile")
    ok(any("String" in e or "不兼容" in e or "incompatible" in e for e in r["compile_errors"]),
       "编译错误信息里能看到原因", str(r["compile_errors"][:1]))

    # 3. 运行期异常
    r = run_java({"Boom.java": "public class Boom { public static void main(String[] a) { throw new IllegalStateException(\"炸了\"); } }"})
    ok(not r["ok"] and r["phase"] == "run", "运行期异常 → phase=run")
    ok(any("炸了" in e for e in r["stderr"]), "异常信息透出来了", str(r["stderr"][:2]))

    # 4. 死循环必须被掐掉（墙钟超时）
    t0 = time.monotonic()
    r = run_java({"Spin.java": "public class Spin { public static void main(String[] a) { while (true) {} } }"}, timeout=4.0)
    spent = time.monotonic() - t0
    ok(r["phase"] == "timeout" and not r["ok"], "死循环被 timeout 掐掉", f"phase={r['phase']}")
    ok(spent < 20, f"掐得够快（{spent:.1f}s）")

    # 5. ★ Servlet（javax）：教材里只写了 Servlet、没有 main，也要能跑
    r = run_java({"HelloServlet.java": SERVLET}, params=["name=张三"])
    ok(r["ok"], "★ 迷你 Servlet API 能让教材 Servlet 编译并跑起来", r.get("error", ""))
    ok("你好, 张三" in r["output"], "getParameter 拿到了参数", repr(r["output"][:80]))
    # ★ 诊断走 stderr、正文走 stdout：判据（stdout）里不能混进驱动的噪声
    ok("[status] 200" in "\n".join(r["stderr"]), "响应状态在 stderr 里（不污染判据）")
    ok("[status]" not in r["output"], "★ stdout 只有正文，没有驱动的诊断信息", repr(r["output"][:80]))
    ok("text/html" in "\n".join(r["stderr"]), "setContentType 生效了（在 stderr 里看得见）")

    # 6. ★ protected service 覆盖必须能编译（访问修饰符保真度）
    r = run_java({"SvcServlet.java": SERVICE_OVERRIDE})
    ok(r["ok"], "★ 教材里 `protected void service` 的覆盖能编译（修饰符和真实 API 一致）",
       str(r["compile_errors"][:2]))
    ok("service 被覆盖" in r["output"], "覆盖的 service 真的被调到了")

    # 7. jakarta 那套包名也要能编译（新教材）
    #    ⚠️ 文件名必须和 public 类名一致，否则 javac 报的错和包名无关，会看错方向
    r = run_java({"HelloServlet.java": SERVLET.replace("javax.servlet", "jakarta.servlet")}, params=["name=李四"])
    ok(r["ok"], "★ jakarta.servlet 那套包名也能编译（新教材用这套）", str(r["compile_errors"][:2]))
    ok("你好, 李四" in r["output"], "jakarta 版响应正确")

    # 8/9/10. 隔离（只有 bwrap 才谈得上）
    r = run_java({"Net.java": """import java.nio.file.*;
public class Net {
  public static void main(String[] a) {
    try { Files.readAllBytes(Paths.get("/root/.ssh/id_rsa")); System.out.println("FS: 读到了密钥！"); }
    catch (Throwable e) { System.out.println("FS: 挡住的"); }
    try { new java.net.Socket().connect(new java.net.InetSocketAddress("1.1.1.1", 80), 2500);
          System.out.println("NET: 连出去了"); }
    catch (Throwable e) { System.out.println("NET: 挡住的"); }
  }
}"""})
    if r["sandbox"] == "bwrap":
        ok("FS: 挡住的" in r["output"], "★ bwrap 里读不到 /home 下的密钥")
        ok("NET: 挡住的" in r["output"], "★ bwrap 里连不出外网")
    else:
        print("  – 本机没有 bwrap，跳过隔离断言（板子上会跑这两条）")

    # 11. ★ 环境变量不能漏进去（云端 key 就在后端进程的环境里）
    canary = "Q8B_SECRET_CANARY"
    os.environ[canary] = "leaked-if-you-see-this"
    try:
        r = run_java({"Env.java": """public class Env {
  public static void main(String[] a) {
    String v = System.getenv("Q8B_SECRET_CANARY");
    System.out.println("CANARY=" + (v == null ? "看不到" : v));
  }
}"""})
    finally:
        os.environ.pop(canary, None)
    if r["sandbox"] == "bwrap":
        ok("CANARY=看不到" in r["output"], "★ 父进程的环境变量没漏进沙箱（--clearenv）", r["output"].strip())
    else:
        print("  – 本机无 bwrap，环境变量会继承（开发用，板子上是 --clearenv）")

    # 12. 写超大文件要被 RLIMIT_FSIZE 掐掉（不然能把磁盘写满）
    #     ⚠️ 这是 posix 专属：Windows 没有 preexec_fn，rlimit 根本设不上，
    #     所以这里**不能报 FAIL**（那会让人以为沙箱漏了），只能像 bwrap 那两条一样标"跳过"。
    if os.name == "posix":
        r = run_java({"Fill.java": """import java.io.*;
public class Fill {
  public static void main(String[] a) throws Exception {
    byte[] buf = new byte[1024 * 1024];
    OutputStream os = new FileOutputStream("big.bin");
    for (int i = 0; i < 200; i++) { os.write(buf); }   // 想写 200MB
    os.close();
    System.out.println("写完了 200MB");
  }
}"""}, timeout=25.0)
        ok("写完了 200MB" not in r["output"], "★ 写超大文件被掐掉（RLIMIT_FSIZE 生效）",
           f"phase={r['phase']} exit={r['exit_code']}")
    else:
        print("  – Windows 没有 preexec_fn，设不了 rlimit，跳过写文件限额断言（板子上会跑）")

    print(f"\n{'✅' if not failed else '❌'} Java 沙箱自检：{passed} 通过 / {failed} 失败")
    return failed == 0


# --------------------------------------------------------------------------
# 6. CLI
# --------------------------------------------------------------------------

def java_file_name(source: str, fallback: str = "Main") -> str:
    """按 Java 的硬规矩给文件名：**public 类名必须等于文件名**。

    ⚠️ 这条踩过（就在写这个工具的时候）：`--file ResponseServlet02.java` 里的类名对不上，
    报的是"类 X 是公共的, 应在名为 X.java 的文件中声明" —— 看着像代码写错了，
    其实是文件名的问题。前端那边有 core/java.js 的 `javaSources()` 做同样的事，
    这里补上，免得用命令行的人白查半天。
    """
    m = re.search(r"\bpublic\s+(?:final\s+|abstract\s+)?(?:class|interface|enum)\s+([A-Za-z_$][\w$]*)", source)
    return f"{m.group(1) if m else fallback}.java"


def main() -> int:
    for stream in (sys.stdout, sys.stderr):
        try:
            stream.reconfigure(encoding="utf-8", errors="replace")
        except (AttributeError, ValueError):
            pass

    ap = argparse.ArgumentParser(description="在板子上真编译真运行 Java（JavaWeb 代码题判据）")
    ap.add_argument("--selftest", action="store_true")
    ap.add_argument("--file", help="要跑的 .java 文件")
    ap.add_argument("--param", action="append", default=[], help="请求参数 k=v（Servlet 用）")
    ap.add_argument("--timeout", type=float, default=15.0)
    ap.add_argument("--memory", type=int, default=128, help="堆上限 MB（注意：不是 ulimit -v）")
    ap.add_argument("--no-sandbox", action="store_true", help="明确不隔离（只给本机调试）")
    args = ap.parse_args()

    if args.selftest:
        return 0 if selftest() else 1
    if not args.file:
        ap.print_help()
        return 2

    path = Path(args.file)
    source = path.read_text(encoding="utf-8")
    result = run_java(
        # 文件名跟着 public 类名走（Java 的硬规矩）——别拿用户给的文件名当类名
        {java_file_name(source, path.stem): source},
        params=args.param,
        timeout=args.timeout,
        memory_mb=args.memory,
        sandbox="none" if args.no_sandbox else "auto",
    )
    print(f"[phase] {result['phase']}  [sandbox] {result['sandbox']}  [{result['ms']}ms]")
    if result["compile_errors"]:
        print("--- 编译错误 ---")
        for line in result["compile_errors"]:
            print("  " + line)
    if result["output"]:
        print("--- stdout ---")
        print(result["output"], end="" if result["output"].endswith("\n") else "\n")
    if result["stderr"]:
        print("--- stderr ---")
        for line in result["stderr"][:20]:
            print("  " + line)
    return 0 if result["ok"] else 1


if __name__ == "__main__":
    raise SystemExit(main())
