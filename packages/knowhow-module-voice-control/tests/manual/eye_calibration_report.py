# Offline report on a saved eye-tracking calibration: feature signal/noise, head pose per run,
# leave-one-dot-out error per monitor, drift over time, eyes-only vs head-only models.
# Usage: ~/.cache/knowhow/eye-tracking/venv/bin/python tests/manual/eye_calibration_report.py [calibration.json]

import json, numpy as np
import sys, os
c=json.load(open(sys.argv[1] if len(sys.argv)>1 else os.path.expanduser('~/.cache/knowhow/eye-tracking/calibration.json')))
rows=[(k,s) for k,v in c['monitors'].items() for s in v['samples']]
F=np.array([s['f'] for _,s in rows]);X=np.array([[s['x'],s['y']] for _,s in rows]);G=np.array([s['g'] for _,s in rows]);M=np.array([k for k,_ in rows])
run=np.array([g.split('#')[1].split(':')[0] for g in G])
def ex(F): return np.hstack([F,F[:,[0]]**2,F[:,[1]]**2,F[:,[0]]*F[:,[1]],F[:,[0]]*F[:,[4]],F[:,[1]]*F[:,[5]]])
def fit(F,Y,lam=3):
    E=ex(F);mu=E.mean(0);sd=E.std(0)+1e-6;Z=(E-mu)/sd;n=Z.shape[1]
    W=np.linalg.solve(Z.T@Z+lam*len(Z)/len(Z)*np.eye(n)*1, Z.T@(Y-Y.mean(0)))
    return lambda f:((ex(f)-mu)/sd)@W+Y.mean(0)
def lodo(F,X,G,lam):
    errs=[]
    for g in np.unique(G):
        tr=G!=g; p=fit(F[tr],X[tr],lam)(F[~tr]); errs.append(np.hypot(*(p.mean(0)-X[~tr][0])))
    return np.array(errs)
names=['irisX','irisY','irisLidY','lidOpen','noseX','noseY','yaw','roll','faceX','faceY','faceW']
print('runs:',{r:(int((run==r).sum()),len(set(G[run==r])), sorted(set(M[run==r]))) for r in sorted(set(run))})
# feature ranges & within-dot noise
within=np.array([F[G==g].std(0) for g in np.unique(G)]).mean(0)
dm=np.array([F[G==g].mean(0) for g in np.unique(G)])
print('feature  between-dot-std  within-dot-std  ratio')
for i,n in enumerate(names): print(f'{n:9s} {dm[:,i].std():.4f} {within[i]:.4f} {dm[:,i].std()/max(within[i],1e-9):.1f}')
# head pose drift per run
for r in sorted(set(run)):
    s=run==r; print('run',r,'faceW %.3f faceX %.3f faceY %.3f yaw %.3f noseX %.3f'%tuple(F[s][:,[10,8,9,6,4]].mean(0)))
for mon in sorted(set(M)):
    s=M==mon
    for lam in [1,10,100]:
        e=lodo(F[s],X[s],G[s],lam); print('monitor',mon,'lam',lam,'per-dot LODO mean %.0f median %.0f px'%(e.mean(),np.median(e)))
# within each run only (no cross-session poisoning)
for r in sorted(set(run)):
    s=run==r
    if len(set(G[s]))>=8:
        e=lodo(F[s],X[s],G[s],10);print('run-only',r,'dots',len(set(G[s])),'LODO mean %.0f median %.0f'%(e.mean(),np.median(e)))
# iris-only model vs full
s=np.ones(len(F),bool)
e=lodo(F,X,G,10);print('all combined LODO mean %.0f'%e.mean())
# frame-level jitter in px using combined model
p=fit(F,X,10)(F);jit=np.mean([np.hypot(*(p[G==g]-p[G==g].mean(0)).std(0)) for g in np.unique(G)]);print('frame jitter (px, 1 sd) %.0f'%jit)
print('--- axis / drift ---')
for mon in sorted(set(M)):
    s=M==mon; gs=[g for g in dict.fromkeys(G[s])]
    errs=[];ax=[]
    for g in gs:
        tr=s&(G!=g);te=G==g;p=fit(F[tr],X[tr],10)(F[te]).mean(0);d=p-X[te][0];ax.append(d)
    ax=np.array(ax);print(mon,'mean |dx| %.0f |dy| %.0f'%tuple(np.abs(ax).mean(0)))
    q=len(gs)//4
    for i in range(4): print('  quarter',i,'mean err %.0f'%np.hypot(ax[i*q:(i+1)*q,0],ax[i*q:(i+1)*q,1]).mean())
    # train on first half, test on second half (temporal generalization)
    h=set(gs[:len(gs)//2]);tr=s&np.isin(G,list(h));te=s&~np.isin(G,list(h))
    p=fit(F[tr],X[tr],10)
    e=[np.hypot(*(p(F[te&(G==g)]).mean(0)-X[G==g][0])) for g in gs[len(gs)//2:]];print('  train first half -> test second half mean %.0f'%np.mean(e))
    # eyes only features (iris+lid) vs head only
    for nm,cols in [('eyes-only',[0,1,2,3]),('head-only',[4,5,6,7,8,9,10])]:
        D=np.array([F[G==g].mean(0) for g in gs]);T=np.array([X[G==g][0] for g in gs])
        A=np.hstack([D[:,cols],np.ones((len(D),1))]);e=[]
        for i in range(len(D)):
            k=np.arange(len(D))!=i;w=np.linalg.lstsq(A[k],T[k],rcond=None)[0];e.append(np.hypot(*(A[i]@w-T[i])))
        print('  linear',nm,'LODO %.0f'%np.mean(e))
