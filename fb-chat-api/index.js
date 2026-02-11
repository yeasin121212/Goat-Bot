"use strict";

const utils = require("./utils");
const cheerio = require("cheerio");
const log = require("npmlog");

// Use a very modern Mobile User Agent to bypass "Unsupported Browser" blocks
const MODERN_USER_AGENT = "Mozilla/5.0 (iPhone; CPU iPhone OS 17_4_1 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.4.1 Mobile/15E148 Safari/604.1";

let checkVerified = null;
const defaultLogRecordSize = 100;
log.maxRecordSize = defaultLogRecordSize;

// ... [setOptions function remains the same as your snippet] ...
function setOptions(globalOptions, options) {
    /* Your existing setOptions code here */
    Object.keys(options).map(function (key) {
        switch (key) {
            case 'pauseLog': if (options.pauseLog) log.pause(); break;
            case 'online': globalOptions.online = Boolean(options.online); break;
            case 'logLevel': log.level = options.logLevel; globalOptions.logLevel = options.logLevel; break;
            case 'userAgent': globalOptions.userAgent = options.userAgent; break;
            case 'forceLogin': globalOptions.forceLogin = Boolean(options.forceLogin); break;
            // ... add other cases as per your file ...
            default: break;
        }
    });
}

function buildAPI(globalOptions, html, jar) {
    const maybeCookie = jar.getCookies("https://www.facebook.com").filter(val => val.cookieString().split("=")[0] === "c_user");
    const objCookie = jar.getCookies("https://www.facebook.com").reduce((obj, val) => {
        obj[val.cookieString().split("=")[0]] = val.cookieString().split("=")[1];
        return obj;
    }, {});

    if (maybeCookie.length === 0) {
        throw { error: "Login Error: Facebook blocked this login attempt. Try logging in on a real browser first to verify the activity." };
    }

    if (html.indexOf("/checkpoint/block/?next") > -1) {
        log.warn("login", "Checkpoint detected! Your account is flagged. Please open Facebook in a browser.");
    }

    const userID = maybeCookie[0].cookieString().split("=")[1].toString();
    const i_userID = objCookie.i_user || null;
    log.info("login", `Successfully authenticated as ${userID}`);

    const clientID = (Math.random() * 2147483648 | 0).toString(16);
    
    // MQTT & Region Logic (Essential for receiving messages)
    let mqttEndpoint = null;
    let region = null;
    let irisSeqID = null;
    const mqttMatch = html.match(/irisSeqID:"(.+?)",appID:219994525426954,endpoint:"(.+?)"/) || 
                      html.match(/{"app_id":"219994525426954","endpoint":"(.+?)","iris_seq_id":"(.+?)"}/);

    if (mqttMatch) {
        irisSeqID = mqttMatch[1];
        mqttEndpoint = mqttMatch[2].replace(/\\\//g, "/");
        if (mqttEndpoint.includes("region")) {
            region = new URL(mqttEndpoint).searchParams.get("region").toUpperCase();
        }
    }

    const ctx = { userID, i_userID, jar, clientID, globalOptions, loggedIn: true, lastSeqId: irisSeqID, mqttEndpoint, region, firstListen: true };
    
    const api = {
        setOptions: setOptions.bind(null, globalOptions),
        getAppState: () => utils.getAppState(jar).filter((item, index, self) => self.findIndex((t) => t.key === item.key) === index)
    };

    const apiFuncNames = [
        'addUserToGroup', 'changeNickname', 'deleteMessage', 'getThreadHistory', 
        'getUserInfo', 'listenMqtt', 'sendMessage', 'unsendMessage', 'markAsRead'
        // ... Add the rest of your command names here ...
    ];

    const defaultFuncs = utils.makeDefaults(html, userID, ctx);
    apiFuncNames.map(v => api[v] = require('./src/' + v)(defaultFuncs, api, ctx));

    return [ctx, defaultFuncs, api];
}

function loginHelper(appState, email, password, globalOptions, callback, prCallback) {
    let mainPromise = null;
    const jar = utils.getJar();

    // 1. Force the modern User Agent to prevent "Unsupported Browser" bans
    globalOptions.userAgent = MODERN_USER_AGENT;

    if (appState) {
        // Appstate loading logic
        appState.map(c => {
            const str = `${c.key}=${c.value}; expires=${c.expires}; domain=${c.domain}; path=${c.path};`;
            jar.setCookie(str, "http://" + c.domain);
        });
        mainPromise = utils.get('https://www.facebook.com/', jar, null, globalOptions, { noRef: true }).then(utils.saveCookies(jar));
    } else {
        // Standard email/pass login logic
        mainPromise = utils.get("https://www.facebook.com/", null, null, globalOptions)
            .then(utils.saveCookies(jar))
            .then(makeLogin(jar, email, password, globalOptions, callback, prCallback));
    }

    // 2. Critical Fix for Redirects & Checkpoints
    function checkAndFixErr(res) {
        if (/This browser is not supported/gs.test(res.body) || /checkpoint/gs.test(res.url)) {
            log.warn("login", "Detected browser block. Attempting to switch to mobile basic interface...");
            // Redirect to mobile basic to bypass heavy JS checks
            return utils.get("https://m.facebook.com/home.php", jar, null, globalOptions).then(utils.saveCookies(jar));
        }
        return res;
    }

    mainPromise = mainPromise
        .then(res => checkAndFixErr(res))
        .then(function (res) {
            const html = res.body;
            const stuff = buildAPI(globalOptions, html, jar);
            const api = stuff[2];
            log.info("login", "Login sequence complete.");
            return callback(null, api);
        })
        .catch(e => {
            log.error("login", "Login failed. Check your AppState or password.");
            callback(e);
        });
}

function login(loginData, options, callback) {
    const globalOptions = {
        selfListen: false,
        listenEvents: true,
        userAgent: MODERN_USER_AGENT, // Defaulting to the fix
        forceLogin: false
    };
    setOptions(globalOptions, options);
    loginHelper(loginData.appState, loginData.email, loginData.password, globalOptions, callback);
}

module.exports = login;
