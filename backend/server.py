from ceapp import app

if __name__ == '__main__':
    # Flask開発サーバーのデフォルトはシングルスレッドなので、
    # バックグラウンドスレッドとリクエスト処理が競合しないように threaded=True を指定
    # use_reloader=False は、スレッドが複数起動されるのを避けるためにデバッグ時に有効
    app.run(debug=True, host='0.0.0.0', port=5000, threaded=True, use_reloader=False)