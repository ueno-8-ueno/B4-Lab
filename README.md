# 起動方法
```bash
cd frontend
nmp install # v22.16.0 推奨
npm run dev
```

```bash
pip3 install Flask-CORS #初回いるかも

cd backend
python3 server.py
```

# containerlabトポロジ
### /topology-frr
- FRRoutingを用いたOSPFが動作する六角形トポロジ

### /topology-srl
- Nokia SRLinuxのOSイメージを用いたspine/leaf構造のトポロジ