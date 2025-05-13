from ceapp import app

if __name__ == '__main__':
    # host='0.0.0.0' を指定すると、同じネットワーク内の他のPCからもアクセス可能になります。
    # debug=True は開発時に便利ですが、本番環境ではFalseにしてください。
    app.run(debug=True, host='0.0.0.0', port=5000)