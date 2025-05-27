from flask import Flask
from flask_cors import CORS
# osモジュールを使う場合は import os が必要です
import os 

app = Flask(__name__)
# React開発サーバー (localhost:5173) からの /api/ プレフィックスを持つリクエストを許可
CORS(app, resources={r"/api/*": {"origins": "http://localhost:5173"}})
app.secret_key = os.urandom(24) # グローバルなsecret_key

# 注意: app.secret_keyをここで設定したので、measure.pyやinsert.pyの個別のsecret_key設定は削除します。

import ceapp.measure
import ceapp.insert