#requires -Version 5.1
param([string]$OutputDirectory = $PSScriptRoot)
$ErrorActionPreference = 'Stop'
$AegisOverall=[Diagnostics.Stopwatch]::StartNew()
$AegisPayloadBase64 = 'J3VzZSBzdHJpY3QnOwovLyBTdGFuZGFsb25lIHJlYWQtb25seSBjb2xsZWN0b3IuIE5ldmVyIHJlcXVpcmUgZGIuanMsIHNlcnZlci5qcyBvciBtaWdyYXRpb24gY29kZS4KY29uc3QgZnMgPSByZXF1aXJlKCdub2RlOmZzJyk7CmNvbnN0IHBhdGggPSByZXF1aXJlKCdub2RlOnBhdGgnKTsKY29uc3QgY3J5cHRvID0gcmVxdWlyZSgnbm9kZTpjcnlwdG8nKTsKY29uc3QgdGxzID0gcmVxdWlyZSgnbm9kZTp0bHMnKTsKY29uc3QgTEVHQUNZX0RCX1NIQTI1NiA9ICc3MmJmMGJhZDM5MDE4OTAyMDA5MWRhYmU0OWU5NTU0MmNhNjY2NGVhYTVjNzg5MGM4MTg5ZWIwMzVlMTlmZDljJzsKY29uc3QgUkVRVUlSRURfVEFCTEVTID0gWydjb21wYW5pZXMnLCdzaXRlcycsJ2d1YXJkcycsJ2d1YXJkX3Nlc3Npb25zJywnaW5jaWRlbnRzJywnaW5jaWRlbnRfZ3VhcmRfcmVzcG9uc2VzJywnc2NoZW1hX21pZ3JhdGlvbnMnLCdkYXNoYm9hcmRfcm9sZXMnLCdkYXNoYm9hcmRfcGVybWlzc2lvbnMnLCdkYXNoYm9hcmRfcm9sZV9wZXJtaXNzaW9ucycsJ3VzZXJfZGFzaGJvYXJkX3JvbGVzJywnYWRtaW5fc2Vzc2lvbnMnXTsKY29uc3QgU0FGRV9NSUdSQVRJT05fQ09MVU1OUyA9IFsnbmFtZScsJ2ZpbGVuYW1lJywnbWlncmF0aW9uX25hbWUnLCd2ZXJzaW9uJywnY2hlY2tzdW0nLCdhcHBsaWVkX2F0J107CmNvbnN0IFNBRkVfRVJST1JTID0gbmV3IFNldChbJ0VDT05OUkVGVVNFRCcsJ0VDT05OUkVTRVQnLCdFTk9URk9VTkQnLCdFVElNRURPVVQnLCdFUlJfVExTX0NFUlRfQUxUTkFNRV9JTlZBTElEJywnREVQVEhfWkVST19TRUxGX1NJR05FRF9DRVJUJywnU0VMRl9TSUdORURfQ0VSVF9JTl9DSEFJTicsJ1VOQUJMRV9UT19WRVJJRllfTEVBRl9TSUdOQVRVUkUnLCdVTkFCTEVfVE9fR0VUX0lTU1VFUl9DRVJUX0xPQ0FMTFknLCdDRVJUX0hBU19FWFBJUkVEJywnQ0VSVF9OT1RfWUVUX1ZBTElEJywnRVJSX09TU0xfUEVNX05PX1NUQVJUX0xJTkUnXSk7CmZ1bmN0aW9uIGNvZGUoZXJyb3IpIHsgcmV0dXJuIFNBRkVfRVJST1JTLmhhcyhlcnJvcj8uY29kZSkgfHwgL15bMC05QS1aXXs1fSQvLnRlc3QoZXJyb3I/LmNvZGUgfHwgJycpID8gZXJyb3IuY29kZSA6ICdDT0xMRUNUSU9OX0ZBSUxFRCc7IH0KZnVuY3Rpb24gc2hhKHZhbHVlKSB7IHJldHVybiBjcnlwdG8uY3JlYXRlSGFzaCgnc2hhMjU2JykudXBkYXRlKHZhbHVlKS5kaWdlc3QoJ2hleCcpOyB9CmZ1bmN0aW9uIGZhdWx0KHZhbHVlKSB7IGNvbnN0IGVycm9yID0gbmV3IEVycm9yKHZhbHVlKTsgZXJyb3Iuc2FmZUNvZGUgPSB2YWx1ZTsgcmV0dXJuIGVycm9yOyB9CmNvbnN0IFBVQkxJQ19VTlRSVVNURURfQ0EgPSAiLS0tLS1CRUdJTiBDRVJUSUZJQ0FURS0tLS0tXG5NSUlETXpDQ0FodWdBd0lCQWdJVUg3OTRjeHhvZFc5R2d2cUFqbjRCZlFkcnNhRXdEUVlKS29aSWh2Y05BUUVMXG5CUUF3S1RFbk1DVUdBMVVFQXd3ZVFVVkhTVk10VTFsT1ZFaEZWRWxETFZWT1ZGSlZVMVJGUkMxU1QwOVVNQjRYXG5EVEkyTVRFeU5URTBNall4T0ZvWERUTTJNVEV5TWpFME1qWXhPRm93S1RFbk1DVUdBMVVFQXd3ZVFVVkhTVk10XG5VMWxPVkVoRlZFbERMVlZPVkZKVlUxUkZSQzFTVDA5VU1JSUJJakFOQmdrcWhraUc5dzBCQVFFRkFBT0NBUThBXG5NSUlCQ2dLQ0FRRUFwdWJkRTFVQ1ppN0M2L1ZMSEtFK05yK2Zncm14UXVFZEFRQTc4bFp3Z1JVcmNpQS9ib2V1XG4veUMvMmZwdUtMNXJKelRFN2xoQlVsSFk0Q1hRQ1YrMXgrTWZsVkhVYWo3OVlTVEdsKzVjNHRCS2RMcFg5MkF0XG5xaGFjZXFQaHQ4WVhlTkJlME1uekZ0eDZySzM1L3hjbVg4RW9GZllBRU8yNDBkbkdkNTZESWdQaEcycVQxaHdiXG53TUhTc3BDVGw2dTR4Vm5xQ3dqUlF4N1hrZE00WEthbE5XMUZnYk9OZVZYbGpGTHdMSWJJUzExYVdrUVhnc1pTXG5jNVhORStxV2MyVDJnbmNKMnBzWmtCRTZJaGR5cWlGemp0azFtMGtwTWxEZm91ZUV2WUg4VUx1WHg2MUN5VTJlXG5vQS9IbmZqUEo2VU5PTlJoSTJDYUk4ZXdKdXROUDhNZlpRSURBUUFCbzFNd1VUQWRCZ05WSFE0RUZnUVUrWm1mXG5NWjBNZXptcXBnZ1RDdFFNc0RmV1RnOHdId1lEVlIwakJCZ3dGb0FVK1ptZk1aME1lem1xcGdnVEN0UU1zRGZXXG5UZzh3RHdZRFZSMFRBUUgvQkFVd0F3RUIvekFOQmdrcWhraUc5dzBCQVFzRkFBT0NBUUVBUFJyamhhMk93UmZJXG50SVNkT2NtcWdseXhBM3B1OC9jR1hGVDdYZk9WbmJsQUh2MjFMRzBVb2psblUrWXUzVXFFdHNWckYrL2dxTmdrXG5aYzQ1SDF2RHZ1OXJnbFhEWEVZV1FIU3lZYzRLYTh4M1NqM1hmTldpTzdPdEQ1VWdzUUZBQk9DRTBiSmU0amNxXG4wUE5jTEFhbVA4dTE1WkRZRDBBZmN5RzdzOGJuMTJXRVVNRFVpZlJJSHMyU0FrdnoxbVNVZUY3U0hHTmlpOERMXG5McmpzSDhzVkdLdkxnSWdia21WQTREU0NpQktNQjhuNG5rR2xCYlhGUXdwcDYxcFJBMTVJZXdYQlFFaTIyR2J2XG5TbmF1UkFKK3BnNUcrdVRRcXYwb1Z3N3l2S3Y2NnB5b2RKQktsUzAzcktOa2FOVEhRcVdMN0NrZnVEOVRnTHA3XG5jd0QranB0bCt3PT1cbi0tLS0tRU5EIENFUlRJRklDQVRFLS0tLS1cbiI7CmNvbnN0IFFVRVJJRVMgPSB7CiAgZW52aXJvbm1lbnQ6ICJTRUxFQ1QgdmVyc2lvbigpIEFTIHNlcnZlcl92ZXJzaW9uLGN1cnJlbnRfZGF0YWJhc2UoKSBBUyBkYXRhYmFzZSxjdXJyZW50X3VzZXIgQVMgcnVudGltZV9yb2xlLHNlc3Npb25fdXNlciBBUyBzZXNzaW9uX3JvbGUsY3VycmVudF9zZXR0aW5nKCdUaW1lWm9uZScpIEFTIHRpbWV6b25lLGN1cnJlbnRfc2V0dGluZygndHJhbnNhY3Rpb25fcmVhZF9vbmx5JykgQVMgdHJhbnNhY3Rpb25fcmVhZF9vbmx5LGN1cnJlbnRfc2V0dGluZygncm93X3NlY3VyaXR5JykgQVMgcm93X3NlY3VyaXR5IiwKICB0YWJsZXM6ICJTRUxFQ1QgYy5yZWxuYW1lLHBnX2dldF91c2VyYnlpZChjLnJlbG93bmVyKSBBUyBvd25lcixjLnJlbHJvd3NlY3VyaXR5LGMucmVsZm9yY2Vyb3dzZWN1cml0eSxjLnJlbHR1cGxlczo6YmlnaW50IEFTIGFwcHJveGltYXRlX3Jvd3MscGdfaGFzX3JvbGUoY3VycmVudF91c2VyLGMucmVsb3duZXIsJ1VTQUdFJykgQVMgb3duZXJfcHJpdmlsZWdlcyxoYXNfdGFibGVfcHJpdmlsZWdlKGN1cnJlbnRfdXNlcixjLm9pZCwnU0VMRUNUJykgQVMgY2FuX3NlbGVjdCxoYXNfdGFibGVfcHJpdmlsZWdlKGN1cnJlbnRfdXNlcixjLm9pZCwnSU5TRVJUJykgQVMgY2FuX2luc2VydCxoYXNfdGFibGVfcHJpdmlsZWdlKGN1cnJlbnRfdXNlcixjLm9pZCwnVVBEQVRFJykgQVMgY2FuX3VwZGF0ZSxoYXNfdGFibGVfcHJpdmlsZWdlKGN1cnJlbnRfdXNlcixjLm9pZCwnREVMRVRFJykgQVMgY2FuX2RlbGV0ZSxoYXNfdGFibGVfcHJpdmlsZWdlKGN1cnJlbnRfdXNlcixjLm9pZCwnVFJVTkNBVEUnKSBBUyBjYW5fdHJ1bmNhdGUsaGFzX3RhYmxlX3ByaXZpbGVnZShjdXJyZW50X3VzZXIsYy5vaWQsJ1JFRkVSRU5DRVMnKSBBUyBjYW5fcmVmZXJlbmNlLGhhc190YWJsZV9wcml2aWxlZ2UoY3VycmVudF91c2VyLGMub2lkLCdUUklHR0VSJykgQVMgY2FuX3RyaWdnZXIgRlJPTSBwZ19jbGFzcyBjIEpPSU4gcGdfbmFtZXNwYWNlIG4gT04gbi5vaWQ9Yy5yZWxuYW1lc3BhY2UgV0hFUkUgbi5uc3BuYW1lPSdwdWJsaWMnIEFORCBjLnJlbGtpbmQgSU4gKCdyJywncCcpIE9SREVSIEJZIGMucmVsbmFtZSIsCiAgY29sdW1uczogIlNFTEVDVCB0YWJsZV9uYW1lLGNvbHVtbl9uYW1lLGRhdGFfdHlwZSx1ZHRfbmFtZSxpc19udWxsYWJsZSxjb2x1bW5fZGVmYXVsdCBGUk9NIGluZm9ybWF0aW9uX3NjaGVtYS5jb2x1bW5zIFdIRVJFIHRhYmxlX3NjaGVtYT0ncHVibGljJyBBTkQgdGFibGVfbmFtZT1BTlkoJDE6OnRleHRbXSkgT1JERVIgQlkgdGFibGVfbmFtZSxvcmRpbmFsX3Bvc2l0aW9uIiwKICBjb25zdHJhaW50czogIlNFTEVDVCBjLnJlbG5hbWUsY29uLmNvbm5hbWUsY29uLmNvbnR5cGUsY29uLmNvbnZhbGlkYXRlZCxwZ19nZXRfY29uc3RyYWludGRlZihjb24ub2lkKSBBUyBkZWZpbml0aW9uIEZST00gcGdfY29uc3RyYWludCBjb24gSk9JTiBwZ19jbGFzcyBjIE9OIGMub2lkPWNvbi5jb25yZWxpZCBKT0lOIHBnX25hbWVzcGFjZSBuIE9OIG4ub2lkPWMucmVsbmFtZXNwYWNlIFdIRVJFIG4ubnNwbmFtZT0ncHVibGljJyBPUkRFUiBCWSBjLnJlbG5hbWUsY29uLmNvbm5hbWUiLAogIGluZGV4ZXM6ICJTRUxFQ1QgdGFibGVuYW1lLGluZGV4bmFtZSxpbmRleGRlZiBGUk9NIHBnX2luZGV4ZXMgV0hFUkUgc2NoZW1hbmFtZT0ncHVibGljJyBPUkRFUiBCWSB0YWJsZW5hbWUsaW5kZXhuYW1lIiwKICB0cmlnZ2VyczogIlNFTEVDVCBjLnJlbG5hbWUsdC50Z25hbWUscGdfZ2V0X3RyaWdnZXJkZWYodC5vaWQpIEFTIGRlZmluaXRpb24gRlJPTSBwZ190cmlnZ2VyIHQgSk9JTiBwZ19jbGFzcyBjIE9OIGMub2lkPXQudGdyZWxpZCBKT0lOIHBnX25hbWVzcGFjZSBuIE9OIG4ub2lkPWMucmVsbmFtZXNwYWNlIFdIRVJFIG4ubnNwbmFtZT0ncHVibGljJyBBTkQgTk9UIHQudGdpc2ludGVybmFsIE9SREVSIEJZIGMucmVsbmFtZSx0LnRnbmFtZSIsCiAgZXh0ZW5zaW9uczogJ1NFTEVDVCBleHRuYW1lLGV4dHZlcnNpb24gRlJPTSBwZ19leHRlbnNpb24gT1JERVIgQlkgZXh0bmFtZScsCiAgcm9sZXM6ICJTRUxFQ1Qgcm9sbmFtZSxyb2xzdXBlcixyb2xpbmhlcml0LHJvbGNyZWF0ZXJvbGUscm9sY3JlYXRlZGIscm9sY2FubG9naW4scm9scmVwbGljYXRpb24scm9sYnlwYXNzcmxzLHBnX2hhc19yb2xlKGN1cnJlbnRfdXNlcixvaWQsJ01FTUJFUicpIEFTIHJ1bnRpbWVfaXNfbWVtYmVyLHBnX2hhc19yb2xlKGN1cnJlbnRfdXNlcixvaWQsJ1VTQUdFJykgQVMgcnVudGltZV9oYXNfZWZmZWN0aXZlX3ByaXZpbGVnZXMgRlJPTSBwZ19yb2xlcyBPUkRFUiBCWSByb2xuYW1lIiwKICBtZW1iZXJzaGlwczogJ1NFTEVDVCBwZ19nZXRfdXNlcmJ5aWQobWVtYmVyKSBBUyBtZW1iZXIscGdfZ2V0X3VzZXJieWlkKHJvbGVpZCkgQVMgcm9sZSxhZG1pbl9vcHRpb24gRlJPTSBwZ19hdXRoX21lbWJlcnMgT1JERVIgQlkgMSwyJywKICBncmFudHM6ICJTRUxFQ1QgZ3JhbnRlZSx0YWJsZV9uYW1lLHByaXZpbGVnZV90eXBlLGlzX2dyYW50YWJsZSBGUk9NIGluZm9ybWF0aW9uX3NjaGVtYS5yb2xlX3RhYmxlX2dyYW50cyBXSEVSRSB0YWJsZV9zY2hlbWE9J3B1YmxpYycgT1JERVIgQlkgZ3JhbnRlZSx0YWJsZV9uYW1lLHByaXZpbGVnZV90eXBlIiwKICBkYXRhYmFzZV9wcml2aWxlZ2VzOiAiU0VMRUNUIHBnX2dldF91c2VyYnlpZChkYXRkYmEpIEFTIGRhdGFiYXNlX293bmVyLGhhc19kYXRhYmFzZV9wcml2aWxlZ2UoY3VycmVudF91c2VyLG9pZCwnQ1JFQVRFJykgQVMgY2FuX2NyZWF0ZSxoYXNfZGF0YWJhc2VfcHJpdmlsZWdlKGN1cnJlbnRfdXNlcixvaWQsJ0NPTk5FQ1QnKSBBUyBjYW5fY29ubmVjdCxoYXNfZGF0YWJhc2VfcHJpdmlsZWdlKGN1cnJlbnRfdXNlcixvaWQsJ1RFTVAnKSBBUyBjYW5fdGVtcCBGUk9NIHBnX2RhdGFiYXNlIFdIRVJFIGRhdG5hbWU9Y3VycmVudF9kYXRhYmFzZSgpIiwKICBzY2hlbWFfcHJpdmlsZWdlczogIlNFTEVDVCBuc3BuYW1lLHBnX2dldF91c2VyYnlpZChuc3Bvd25lcikgQVMgb3duZXIsaGFzX3NjaGVtYV9wcml2aWxlZ2UoY3VycmVudF91c2VyLG9pZCwnQ1JFQVRFJykgQVMgY2FuX2NyZWF0ZSxoYXNfc2NoZW1hX3ByaXZpbGVnZShjdXJyZW50X3VzZXIsb2lkLCdVU0FHRScpIEFTIGNhbl91c2UgRlJPTSBwZ19uYW1lc3BhY2UgV0hFUkUgbnNwbmFtZT0ncHVibGljJyIsCiAgc2VxdWVuY2VzOiAiU0VMRUNUIGMucmVsbmFtZSxwZ19nZXRfdXNlcmJ5aWQoYy5yZWxvd25lcikgQVMgb3duZXIsaGFzX3NlcXVlbmNlX3ByaXZpbGVnZShjdXJyZW50X3VzZXIsYy5vaWQsJ1VTQUdFJykgQVMgY2FuX3VzZSxoYXNfc2VxdWVuY2VfcHJpdmlsZWdlKGN1cnJlbnRfdXNlcixjLm9pZCwnU0VMRUNUJykgQVMgY2FuX3NlbGVjdCxoYXNfc2VxdWVuY2VfcHJpdmlsZWdlKGN1cnJlbnRfdXNlcixjLm9pZCwnVVBEQVRFJykgQVMgY2FuX3VwZGF0ZSBGUk9NIHBnX2NsYXNzIGMgSk9JTiBwZ19uYW1lc3BhY2UgbiBPTiBuLm9pZD1jLnJlbG5hbWVzcGFjZSBXSEVSRSBuLm5zcG5hbWU9J3B1YmxpYycgQU5EIGMucmVsa2luZD0nUycgT1JERVIgQlkgYy5yZWxuYW1lIiwKICByb3V0aW5lczogIlNFTEVDVCBwLnByb25hbWUscGdfZ2V0X2Z1bmN0aW9uX2lkZW50aXR5X2FyZ3VtZW50cyhwLm9pZCkgQVMgYXJndW1lbnRzLHBnX2dldF91c2VyYnlpZChwLnByb293bmVyKSBBUyBvd25lcixwLnByb3NlY2RlZiBBUyBzZWN1cml0eV9kZWZpbmVyLGhhc19mdW5jdGlvbl9wcml2aWxlZ2UoY3VycmVudF91c2VyLHAub2lkLCdFWEVDVVRFJykgQVMgY2FuX2V4ZWN1dGUgRlJPTSBwZ19wcm9jIHAgSk9JTiBwZ19uYW1lc3BhY2UgbiBPTiBuLm9pZD1wLnByb25hbWVzcGFjZSBXSEVSRSBuLm5zcG5hbWU9J3B1YmxpYycgT1JERVIgQlkgcC5wcm9uYW1lLHAub2lkIiwKICBkZWZhdWx0X2FjbDogIlNFTEVDVCBwZ19nZXRfdXNlcmJ5aWQoZGVmYWNscm9sZSkgQVMgb3duZXIsbi5uc3BuYW1lIEFTIHNjaGVtYSxhLmRlZmFjbG9ianR5cGUsYS5kZWZhY2xhY2w6OnRleHQgQVMgYWNsIEZST00gcGdfZGVmYXVsdF9hY2wgYSBMRUZUIEpPSU4gcGdfbmFtZXNwYWNlIG4gT04gbi5vaWQ9YS5kZWZhY2xuYW1lc3BhY2UgV0hFUkUgbi5uc3BuYW1lPSdwdWJsaWMnIE9SIGEuZGVmYWNsbmFtZXNwYWNlPTAiLAogIHJsczogIlNFTEVDVCBzY2hlbWFuYW1lLHRhYmxlbmFtZSxwb2xpY3luYW1lLHJvbGVzLGNtZCxxdWFsLHdpdGhfY2hlY2sgRlJPTSBwZ19wb2xpY2llcyBXSEVSRSBzY2hlbWFuYW1lPSdwdWJsaWMnIE9SREVSIEJZIHRhYmxlbmFtZSxwb2xpY3luYW1lIiwKICB0bHNfdHJhbnNwb3J0OiAnU0VMRUNUIHNzbCx2ZXJzaW9uLGNpcGhlcixiaXRzIEZST00gcGdfc3RhdF9zc2wgV0hFUkUgcGlkPXBnX2JhY2tlbmRfcGlkKCknLAogIG1pZ3JhdGlvbl9jb2x1bW5zOiAiU0VMRUNUIGNvbHVtbl9uYW1lLGRhdGFfdHlwZSBGUk9NIGluZm9ybWF0aW9uX3NjaGVtYS5jb2x1bW5zIFdIRVJFIHRhYmxlX3NjaGVtYT0ncHVibGljJyBBTkQgdGFibGVfbmFtZT0nc2NoZW1hX21pZ3JhdGlvbnMnIE9SREVSIEJZIG9yZGluYWxfcG9zaXRpb24iCn07CmZ1bmN0aW9uIHN0cmljdE9wdGlvbnMoY29ubmVjdGlvblN0cmluZywgZXhwZWN0ZWRJZGVudGl0eSwgY2EsIHRlbGVtZXRyeSkgewogIGNvbnN0IHVyaSA9IG5ldyBVUkwoY29ubmVjdGlvblN0cmluZyk7CiAgaWYgKCFbJ3Bvc3RncmVzOicsICdwb3N0Z3Jlc3FsOiddLmluY2x1ZGVzKHVyaS5wcm90b2NvbCkpIHRocm93IGZhdWx0KCdJTlZBTElEX0RBVEFCQVNFX0NPTkZJR1VSQVRJT04nKTsKICBmb3IgKGNvbnN0IGtleSBvZiBbJ3NzbCcsJ3NzbG1vZGUnLCdzc2xjZXJ0Jywnc3Nsa2V5Jywnc3Nscm9vdGNlcnQnLCd1c2VsaWJwcWNvbXBhdCddKSB1cmkuc2VhcmNoUGFyYW1zLmRlbGV0ZShrZXkpOwogIHJldHVybiB7CiAgICBjb25uZWN0aW9uU3RyaW5nOiB1cmkudG9TdHJpbmcoKSwgY29ubmVjdGlvblRpbWVvdXRNaWxsaXM6IDY1MDAsIHF1ZXJ5X3RpbWVvdXQ6IDg1MDAsCiAgICBzc2w6IHsgcmVqZWN0VW5hdXRob3JpemVkOiB0cnVlLCBtaW5WZXJzaW9uOiAnVExTdjEuMicsIC4uLihjYSA/IHsgY2EgfSA6IHt9KSwKICAgICAgY2hlY2tTZXJ2ZXJJZGVudGl0eTogKF9uYW1lLCBjZXJ0KSA9PiB7CiAgICAgICAgdGVsZW1ldHJ5LmRyaXZlcklkZW50aXR5Q2hlY2tzKys7CiAgICAgICAgY29uc3QgcmVzdWx0ID0gdGxzLmNoZWNrU2VydmVySWRlbnRpdHkoZXhwZWN0ZWRJZGVudGl0eSwgY2VydCk7CiAgICAgICAgaWYgKHJlc3VsdCkgdGVsZW1ldHJ5LmRyaXZlcklkZW50aXR5UmVqZWN0ZWQgPSB0cnVlOwogICAgICAgIHJldHVybiByZXN1bHQ7CiAgICAgIH0KICAgIH0KICB9Owp9CmZ1bmN0aW9uIGF0dGVzdFNvY2tldChjbGllbnQsIGV4cGVjdGVkSWRlbnRpdHkpIHsKICBjb25zdCBzb2NrZXQgPSBjbGllbnQuY29ubmVjdGlvbj8uc3RyZWFtOwogIGNvbnN0IGNlcnRpZmljYXRlID0gc29ja2V0Py5nZXRQZWVyQ2VydGlmaWNhdGU/LigpIHx8IHt9OwogIGNvbnN0IGhhc0NlcnRpZmljYXRlID0gQm9vbGVhbihjZXJ0aWZpY2F0ZS5yYXc/Lmxlbmd0aCk7CiAgY29uc3QgaWRlbnRpdHlFcnJvciA9IGhhc0NlcnRpZmljYXRlID8gdGxzLmNoZWNrU2VydmVySWRlbnRpdHkoZXhwZWN0ZWRJZGVudGl0eSwgY2VydGlmaWNhdGUpIDogZmF1bHQoJ1BFRVJfQ0VSVElGSUNBVEVfTUlTU0lORycpOwogIHJldHVybiB7IGVuY3J5cHRlZDogc29ja2V0Py5lbmNyeXB0ZWQgPT09IHRydWUsIGNoYWluVmVyaWZpZWQ6IHNvY2tldD8uYXV0aG9yaXplZCA9PT0gdHJ1ZSwKICAgIHBlZXJDZXJ0aWZpY2F0ZVByZXNlbnQ6IGhhc0NlcnRpZmljYXRlLCBob3N0bmFtZVZlcmlmaWVkOiBoYXNDZXJ0aWZpY2F0ZSAmJiAhaWRlbnRpdHlFcnJvciwKICAgIGNlcnRpZmljYXRlU2hhMjU2OiBoYXNDZXJ0aWZpY2F0ZSA/IHNoYShjZXJ0aWZpY2F0ZS5yYXcpIDogbnVsbCwKICAgIHZlcmlmaWVkOiBzb2NrZXQ/LmVuY3J5cHRlZCA9PT0gdHJ1ZSAmJiBzb2NrZXQ/LmF1dGhvcml6ZWQgPT09IHRydWUgJiYgaGFzQ2VydGlmaWNhdGUgJiYgIWlkZW50aXR5RXJyb3IgfTsKfQphc3luYyBmdW5jdGlvbiBjb2xsZWN0KHsgZW52ID0gcHJvY2Vzcy5lbnYsIGN3ZCA9IHByb2Nlc3MuY3dkKCksIENsaWVudCwgb2JzZXJ2ZVF1ZXJ5ID0gKCkgPT4ge30gfSA9IHt9KSB7CiAgY29uc3Qgb3V0cHV0ID0geyBjb2xsZWN0b3JWZXJzaW9uOiAyLCBjb2xsZWN0ZWRBdDogbmV3IERhdGUoKS50b0lTT1N0cmluZygpLCBtb2RlOiAnUFJPRFVDVElPTl9SRUFEX09OTFlfTUVUQURBVEEnLAogICAgcnVudGltZUNvbmZpZ3VyYXRpb246IHt9LCByZXN1bHRzOiB7fSwgZXJyb3JzOiB7fSwgY29tcGxldGVuZXNzOiB7fSwgZXhlY3V0aW9uOiB7cmVhZE9ubHlUcmFuc2FjdGlvbnNWZXJpZmllZDogMCwgd3JpdGVTdGF0ZW1lbnRzOiAwLCBxdWVyeUNvdW50OiAwfSwKICAgIHByb2R1Y3Rpb25NdXRhdGlvbnM6IGZhbHNlLCBiYWNrdXBSZWNvdmVyYWJpbGl0eTogJ05PVF9FU1RBQkxJU0hFRF9CWV9DQVRBTE9HJyB9OwogIGNvbnN0IGNsaWVudHMgPSBuZXcgU2V0KCk7CiAgYXN5bmMgZnVuY3Rpb24gY3JlYXRlQ2xpZW50KG9wdGlvbnMpIHsKICAgIGNvbnN0IGNsaWVudCA9IG5ldyBDbGllbnQob3B0aW9ucyk7IGNsaWVudHMuYWRkKGNsaWVudCk7IGNsaWVudC5vbignZXJyb3InLCAoKSA9PiB7fSk7CiAgICB0cnkgeyBhd2FpdCBjbGllbnQuY29ubmVjdCgpOyByZXR1cm4gY2xpZW50OyB9IGNhdGNoIChlcnJvcikgeyBhd2FpdCBjbGllbnQuZW5kKCkuY2F0Y2goKCkgPT4ge30pOyBjbGllbnRzLmRlbGV0ZShjbGllbnQpOyB0aHJvdyBlcnJvcjsgfQogIH0KICBhc3luYyBmdW5jdGlvbiBjbG9zZShjbGllbnQpIHsgYXdhaXQgY2xpZW50LmVuZCgpLmNhdGNoKCgpID0+IHt9KTsgY2xpZW50cy5kZWxldGUoY2xpZW50KTsgfQogIGFzeW5jIGZ1bmN0aW9uIHF1ZXJ5KGNsaWVudCwgc2VjdGlvbiwgc3FsLCBwYXJhbXMgPSBbXSkgewogICAgLy8gU1FMIGlzIGNvbnN0cnVjdGVkIG9ubHkgZnJvbSB0aGUgZml4ZWQgbWV0YWRhdGEgaW52ZW50b3J5IGFuZCBjb2x1bW4gYWxsb3dsaXN0LgogICAgaWYgKCEvXihTRUxFQ1QgfEJFR0lOIFJFQUQgT05MWSR8U0VUIExPQ0FMIHxTQVZFUE9JTlQgfFJFTEVBU0UgU0FWRVBPSU5UIHxST0xMQkFDSykvLnRlc3Qoc3FsKSB8fCBzcWwuaW5jbHVkZXMoJzsnKSkgdGhyb3cgZmF1bHQoJ1JFQURfT05MWV9TVEFURU1FTlRfUkVKRUNURUQnKTsKICAgIG9ic2VydmVRdWVyeSh7c2VjdGlvbiwgc3FsLCBwYXJhbXN9KTsgb3V0cHV0LmV4ZWN1dGlvbi5xdWVyeUNvdW50Kys7CiAgICByZXR1cm4gY2xpZW50LnF1ZXJ5KHNxbCwgcGFyYW1zKTsKICB9CiAgYXN5bmMgZnVuY3Rpb24gYmVnaW4oY2xpZW50KSB7CiAgICBhd2FpdCBxdWVyeShjbGllbnQsICdiZWdpbicsICdCRUdJTiBSRUFEIE9OTFknKTsKICAgIGF3YWl0IHF1ZXJ5KGNsaWVudCwgJ3RpbWVvdXQnLCAiU0VUIExPQ0FMIHN0YXRlbWVudF90aW1lb3V0PSc4cyciKTsKICAgIGF3YWl0IHF1ZXJ5KGNsaWVudCwgJ3RpbWVvdXQnLCAiU0VUIExPQ0FMIGxvY2tfdGltZW91dD0nMXMnIik7CiAgICBhd2FpdCBxdWVyeShjbGllbnQsICd0aW1lb3V0JywgIlNFVCBMT0NBTCBpZGxlX2luX3RyYW5zYWN0aW9uX3Nlc3Npb25fdGltZW91dD0nMTBzJyIpOwogICAgY29uc3QgY2hlY2sgPSBhd2FpdCBxdWVyeShjbGllbnQsICdyZWFkX29ubHknLCAiU0VMRUNUIGN1cnJlbnRfc2V0dGluZygndHJhbnNhY3Rpb25fcmVhZF9vbmx5JykgQVMgdmFsdWUiKTsKICAgIGlmIChjaGVjay5yb3dzWzBdPy52YWx1ZSAhPT0gJ29uJykgdGhyb3cgZmF1bHQoJ1JFQURfT05MWV9OT1RfRU5GT1JDRUQnKTsKICAgIG91dHB1dC5leGVjdXRpb24ucmVhZE9ubHlUcmFuc2FjdGlvbnNWZXJpZmllZCsrOwogIH0KICBhc3luYyBmdW5jdGlvbiBwcm9iZShuYW1lLCBpZGVudGl0eSwgY2EpIHsKICAgIGNvbnN0IHRlbGVtZXRyeSA9IHtkcml2ZXJJZGVudGl0eUNoZWNrczogMCwgZHJpdmVySWRlbnRpdHlSZWplY3RlZDogZmFsc2V9OyBsZXQgY2xpZW50OwogICAgdHJ5IHsKICAgICAgY2xpZW50ID0gYXdhaXQgY3JlYXRlQ2xpZW50KHN0cmljdE9wdGlvbnMoZW52LkRBVEFCQVNFX1VSTCwgaWRlbnRpdHksIGNhLCB0ZWxlbWV0cnkpKTsKICAgICAgY29uc3QgYXR0ZXN0YXRpb24gPSBhdHRlc3RTb2NrZXQoY2xpZW50LCBpZGVudGl0eSk7CiAgICAgIGlmICghYXR0ZXN0YXRpb24udmVyaWZpZWQpIHRocm93IGZhdWx0KCdUTFNfQVRURVNUQVRJT05fRkFJTEVEJyk7CiAgICAgIGF3YWl0IGJlZ2luKGNsaWVudCk7IGF3YWl0IHF1ZXJ5KGNsaWVudCwgbmFtZSwgJ1NFTEVDVCAxIEFTIHJlYWRfb25seV9wcm9iZScpOyBhd2FpdCBxdWVyeShjbGllbnQsIG5hbWUsICdST0xMQkFDSycpOwogICAgICByZXR1cm4ge291dGNvbWU6ICdDT05ORUNURUQnLCAuLi5hdHRlc3RhdGlvbiwgLi4udGVsZW1ldHJ5fTsKICAgIH0gY2F0Y2ggKGVycm9yKSB7IHJldHVybiB7b3V0Y29tZTogJ1JFSkVDVEVEJywgdmVyaWZpZWQ6IGZhbHNlLCBjaGFpblZlcmlmaWVkOiBmYWxzZSwgaG9zdG5hbWVWZXJpZmllZDogZmFsc2UsIGNvZGU6IGVycm9yLnNhZmVDb2RlIHx8IGNvZGUoZXJyb3IpLCAuLi50ZWxlbWV0cnl9OyB9CiAgICBmaW5hbGx5IHsgaWYgKGNsaWVudCkgYXdhaXQgY2xvc2UoY2xpZW50KTsgfQogIH0KICB0cnkgewogICAgbGV0IGRiU291cmNlOwogICAgdHJ5IHsgZGJTb3VyY2UgPSBmcy5yZWFkRmlsZVN5bmMocGF0aC5qb2luKGN3ZCwgJ2RiLmpzJykpOyB9IGNhdGNoIHsgdGhyb3cgZmF1bHQoJ0RFUExPWUVEX0RCX1NPVVJDRV9VTkFWQUlMQUJMRScpOyB9CiAgICBvdXRwdXQucnVudGltZUNvbmZpZ3VyYXRpb24uZGJTb3VyY2VTaGEyNTYgPSBzaGEoZGJTb3VyY2UpOwogICAgb3V0cHV0LnJ1bnRpbWVDb25maWd1cmF0aW9uLnByb2ZpbGUgPSBvdXRwdXQucnVudGltZUNvbmZpZ3VyYXRpb24uZGJTb3VyY2VTaGEyNTYgPT09IExFR0FDWV9EQl9TSEEyNTYgPyAnUElOTkVEX0RFUExPWUVEX0xFR0FDWScgOiAnVU5LTk9XTic7CiAgICBpZiAob3V0cHV0LnJ1bnRpbWVDb25maWd1cmF0aW9uLnByb2ZpbGUgPT09ICdVTktOT1dOJykgdGhyb3cgZmF1bHQoJ1JVTlRJTUVfQ09OTkVDVElPTl9DT05GSUdVUkFUSU9OX1VOUkVDT0dOSVpFRCcpOwogICAgaWYgKCFlbnYuREFUQUJBU0VfVVJMKSB0aHJvdyBmYXVsdCgnREFUQUJBU0VfVVJMX1VOQVZBSUxBQkxFJyk7CiAgICBjb25zdCB1cmkgPSBuZXcgVVJMKGVudi5EQVRBQkFTRV9VUkwpOwogICAgaWYgKCFbJ3Bvc3RncmVzOicsICdwb3N0Z3Jlc3FsOiddLmluY2x1ZGVzKHVyaS5wcm90b2NvbCkgfHwgIXVyaS5ob3N0bmFtZSkgdGhyb3cgZmF1bHQoJ0lOVkFMSURfREFUQUJBU0VfQ09ORklHVVJBVElPTicpOwogICAgaWYgKCFDbGllbnQpIENsaWVudCA9IHJlcXVpcmUoJ3BnJykuQ2xpZW50OwogICAgb3V0cHV0LnJ1bnRpbWVDb25maWd1cmF0aW9uLnBnVmVyc2lvbiA9IHJlcXVpcmUoJ3BnL3BhY2thZ2UuanNvbicpLnZlcnNpb247CiAgICBjb25zdCBleHBlY3RlZElkZW50aXR5ID0gZW52LkRBVEFCQVNFX1RMU19JREVOVElUWSB8fCB1cmkuaG9zdG5hbWUucmVwbGFjZSgvXlxbfFxdJC9nLCAnJyk7CiAgICBpZiAoIS9eW0EtWmEtejAtOTouLV17MSwyNTN9JC8udGVzdChleHBlY3RlZElkZW50aXR5KSkgdGhyb3cgZmF1bHQoJ0lOVkFMSURfVExTX0lERU5USVRZJyk7CiAgICBvdXRwdXQucnVudGltZUNvbmZpZ3VyYXRpb24uZXhwZWN0ZWRUbHNJZGVudGl0eSA9IGV4cGVjdGVkSWRlbnRpdHk7CiAgICAvLyBSZXByb2R1Y2UgZXhhY3RseSB0aGUgcGlubmVkIGRlcGxveWVkIG5vZGUtcG9zdGdyZXMgY29ubmVjdGlvbiBjb25maWd1cmF0aW9uLgogICAgLy8gQWRkIG9ubHkgcGVyLWNsaWVudCB0aW1lIGxpbWl0czsgbmV2ZXIgaW1wb3J0IHRoZSBtb2R1bGUncyB0ZXN0RGIoKSBzaWRlIGVmZmVjdC4KICAgIGxldCBydW50aW1lOwogICAgdHJ5IHsKICAgICAgcnVudGltZSA9IGF3YWl0IGNyZWF0ZUNsaWVudCh7Y29ubmVjdGlvblN0cmluZzogZW52LkRBVEFCQVNFX1VSTCwgc3NsOiB7cmVqZWN0VW5hdXRob3JpemVkOiBmYWxzZX0sIGNvbm5lY3Rpb25UaW1lb3V0TWlsbGlzOjY1MDAsIHF1ZXJ5X3RpbWVvdXQ6ODUwMH0pOwogICAgICBjb25zdCBlZmZlY3RpdmUgPSBydW50aW1lLmNvbm5lY3Rpb25QYXJhbWV0ZXJzPy5zc2w7CiAgICAgIGNvbnN0IHNvY2tldCA9IHJ1bnRpbWUuY29ubmVjdGlvbj8uc3RyZWFtOwogICAgICBvdXRwdXQucnVudGltZUNvbmZpZ3VyYXRpb24udGxzID0ge2VuY3J5cHRlZDogc29ja2V0Py5lbmNyeXB0ZWQgPT09IHRydWUsIGNoYWluQXV0aG9yaXplZDogc29ja2V0Py5hdXRob3JpemVkID09PSB0cnVlLCBlZmZlY3RpdmVSZWplY3RVbmF1dGhvcml6ZWQ6IGVmZmVjdGl2ZT8ucmVqZWN0VW5hdXRob3JpemVkID09PSB0cnVlfTsKICAgICAgYXdhaXQgYmVnaW4ocnVudGltZSk7CiAgICAgIGZvciAoY29uc3QgW3NlY3Rpb24sIHNxbF0gb2YgT2JqZWN0LmVudHJpZXMoUVVFUklFUykpIHsKICAgICAgICBhd2FpdCBxdWVyeShydW50aW1lLCAnc2F2ZXBvaW50JywgJ1NBVkVQT0lOVCBtZXRhZGF0YV9pdGVtJyk7CiAgICAgICAgdHJ5IHsgb3V0cHV0LnJlc3VsdHNbc2VjdGlvbl0gPSAoYXdhaXQgcXVlcnkocnVudGltZSwgc2VjdGlvbiwgc3FsLCBzZWN0aW9uID09PSAnY29sdW1ucycgPyBbUkVRVUlSRURfVEFCTEVTLmNvbmNhdCgnaW5jaWRlbnRfcmVzb2x1dGlvbl9hY3Rpb25zJyldIDogW10pKS5yb3dzOyB9CiAgICAgICAgY2F0Y2ggKGVycm9yKSB7IG91dHB1dC5lcnJvcnNbc2VjdGlvbl0gPSBjb2RlKGVycm9yKTsgYXdhaXQgcXVlcnkocnVudGltZSwgJ3JvbGxiYWNrJywgJ1JPTExCQUNLIFRPIFNBVkVQT0lOVCBtZXRhZGF0YV9pdGVtJyk7IH0KICAgICAgICBhd2FpdCBxdWVyeShydW50aW1lLCAncmVsZWFzZScsICdSRUxFQVNFIFNBVkVQT0lOVCBtZXRhZGF0YV9pdGVtJyk7CiAgICAgIH0KICAgICAgY29uc3QgYXZhaWxhYmxlID0gKG91dHB1dC5yZXN1bHRzLm1pZ3JhdGlvbl9jb2x1bW5zIHx8IFtdKS5tYXAocm93ID0+IHJvdy5jb2x1bW5fbmFtZSk7CiAgICAgIGNvbnN0IHNlbGVjdGVkID0gU0FGRV9NSUdSQVRJT05fQ09MVU1OUy5maWx0ZXIobmFtZSA9PiBhdmFpbGFibGUuaW5jbHVkZXMobmFtZSkpOwogICAgICBpZiAoIXNlbGVjdGVkLmxlbmd0aCkgb3V0cHV0LmVycm9ycy5taWdyYXRpb25faGlzdG9yeSA9ICdNSUdSQVRJT05fTUVUQURBVEFfVU5BVkFJTEFCTEUnOwogICAgICBlbHNlIHsKICAgICAgICBjb25zdCBuYW1lcyA9IHNlbGVjdGVkLm1hcChuYW1lID0+ICciJyArIG5hbWUgKyAnIicpLmpvaW4oJywnKTsKICAgICAgICBjb25zdCBjb3VudCA9IE51bWJlcigoYXdhaXQgcXVlcnkocnVudGltZSwgJ21pZ3JhdGlvbl9jb3VudCcsICdTRUxFQ1QgY291bnQoKikgQVMgdG90YWwgRlJPTSBwdWJsaWMuc2NoZW1hX21pZ3JhdGlvbnMnKSkucm93c1swXS50b3RhbCk7CiAgICAgICAgb3V0cHV0LnJlc3VsdHMubWlncmF0aW9uX2hpc3RvcnkgPSAoYXdhaXQgcXVlcnkocnVudGltZSwgJ21pZ3JhdGlvbl9oaXN0b3J5JywgJ1NFTEVDVCAnICsgbmFtZXMgKyAnIEZST00gcHVibGljLnNjaGVtYV9taWdyYXRpb25zIE9SREVSIEJZIDEgTElNSVQgMTAwMScpKS5yb3dzOwogICAgICAgIG91dHB1dC5jb21wbGV0ZW5lc3MubWlncmF0aW9uUm93cyA9IGNvdW50OwogICAgICAgIG91dHB1dC5jb21wbGV0ZW5lc3MubWlncmF0aW9uSGlzdG9yeVRydW5jYXRlZCA9IGNvdW50ID4gMTAwMDsKICAgICAgICBpZiAoY291bnQgPiAxMDAwKSBvdXRwdXQuZXJyb3JzLm1pZ3JhdGlvbl9oaXN0b3J5ID0gJ01JR1JBVElPTl9ISVNUT1JZX0VYQ0VFRFNfQk9VTkQnOwogICAgICB9CiAgICAgIGF3YWl0IHF1ZXJ5KHJ1bnRpbWUsICdyb2xsYmFjaycsICdST0xMQkFDSycpOwogICAgfSBjYXRjaCAoZXJyb3IpIHsgb3V0cHV0LmVycm9ycy5ydW50aW1lX2ludmVudG9yeSA9IGVycm9yLnNhZmVDb2RlIHx8IGNvZGUoZXJyb3IpOyB9CiAgICBmaW5hbGx5IHsgaWYgKHJ1bnRpbWUpIGF3YWl0IGNsb3NlKHJ1bnRpbWUpOyB9CiAgICAvLyBUcnVzdGVkIG1hdGVyaWFsIG11c3QgYWxyZWFkeSBleGlzdCBpbmRlcGVuZGVudGx5IG9mIHRoaXMgcGVlci4gTmV2ZXIgY29weSBhIHBlZXIgQ0EuCiAgICBsZXQgY2E7CiAgICBpZiAoZW52LkRBVEFCQVNFX0NBX0ZJTEUpIHsgdHJ5IHsgY2EgPSBmcy5yZWFkRmlsZVN5bmMoZW52LkRBVEFCQVNFX0NBX0ZJTEUsICd1dGY4Jyk7IH0gY2F0Y2ggeyB0aHJvdyBmYXVsdCgnQ09ORklHVVJFRF9DQV9GSUxFX1VOQVZBSUxBQkxFJyk7IH0gfQogICAgaWYgKGNhICYmICghY2EuaW5jbHVkZXMoJy0tLS0tQkVHSU4gQ0VSVElGSUNBVEUtLS0tLScpIHx8IGNhLmxlbmd0aCA+IDI2MjE0NCkpIHRocm93IGZhdWx0KCdJTlZBTElEX0NPTkZJR1VSRURfQ0EnKTsKICAgIG91dHB1dC5zdHJpY3RUbHMgPSB7dHJ1c3RTb3VyY2U6IGNhID8gJ0VYSVNUSU5HX0NPTkZJR1VSRURfQ0FfRklMRScgOiAnTk9ERV9DT05GSUdVUkVEX1RSVVNUX1NUT1JFJ307CiAgICBvdXRwdXQuc3RyaWN0VGxzLnBvc2l0aXZlID0gYXdhaXQgcHJvYmUoJ3N0cmljdF9wb3NpdGl2ZScsIGV4cGVjdGVkSWRlbnRpdHksIGNhKTsKICAgIGlmIChvdXRwdXQuc3RyaWN0VGxzLnBvc2l0aXZlLnZlcmlmaWVkKSB7CiAgICAgIG91dHB1dC5zdHJpY3RUbHMud3JvbmdIb3N0ID0gYXdhaXQgcHJvYmUoJ3dyb25nX2hvc3RfbmVnYXRpdmUnLCAnYWVnaXMtaW50ZW50aW9uYWxseS13cm9uZy5pbnZhbGlkJywgY2EpOwogICAgICBvdXRwdXQuc3RyaWN0VGxzLnVudHJ1c3RlZENhID0gYXdhaXQgcHJvYmUoJ3VudHJ1c3RlZF9jYV9uZWdhdGl2ZScsIGV4cGVjdGVkSWRlbnRpdHksIFBVQkxJQ19VTlRSVVNURURfQ0EpOwogICAgICBvdXRwdXQuc3RyaWN0VGxzLm5lZ2F0aXZlQ2hlY2tzUGFzc2VkID0gb3V0cHV0LnN0cmljdFRscy53cm9uZ0hvc3Qub3V0Y29tZSA9PT0gJ1JFSkVDVEVEJyAmJiBvdXRwdXQuc3RyaWN0VGxzLndyb25nSG9zdC5jb2RlID09PSAnRVJSX1RMU19DRVJUX0FMVE5BTUVfSU5WQUxJRCcgJiYgb3V0cHV0LnN0cmljdFRscy51bnRydXN0ZWRDYS5vdXRjb21lID09PSAnUkVKRUNURUQnICYmIFsnU0VMRl9TSUdORURfQ0VSVF9JTl9DSEFJTicsJ0RFUFRIX1pFUk9fU0VMRl9TSUdORURfQ0VSVCcsJ1VOQUJMRV9UT19WRVJJRllfTEVBRl9TSUdOQVRVUkUnLCdVTkFCTEVfVE9fR0VUX0lTU1VFUl9DRVJUX0xPQ0FMTFknXS5pbmNsdWRlcyhvdXRwdXQuc3RyaWN0VGxzLnVudHJ1c3RlZENhLmNvZGUpOwogICAgfSBlbHNlIHsKICAgICAgb3V0cHV0LnN0cmljdFRscy53cm9uZ0hvc3QgPSBvdXRwdXQuc3RyaWN0VGxzLnVudHJ1c3RlZENhID0ge291dGNvbWU6J05PVF9FWEVDVVRFRCcsIHJlYXNvbjonVFJVU1RFRF9QT1NJVElWRV9DT05ORUNUSU9OX1JFUVVJUkVEJ307CiAgICAgIG91dHB1dC5zdHJpY3RUbHMubmVnYXRpdmVDaGVja3NQYXNzZWQgPSBmYWxzZTsKICAgIH0KICB9IGNhdGNoIChlcnJvcikgeyBvdXRwdXQuZXJyb3JzLmNvbGxlY3RvciA9IGVycm9yLnNhZmVDb2RlIHx8IGNvZGUoZXJyb3IpOyB9CiAgZmluYWxseSB7IGF3YWl0IFByb21pc2UuYWxsKFsuLi5jbGllbnRzXS5tYXAoY2xpZW50ID0+IGNsb3NlKGNsaWVudCkpKTsgfQogIG91dHB1dC5jb21wbGV0ZW5lc3MubWlzc2luZ1RhYmxlcyA9IFJFUVVJUkVEX1RBQkxFUy5maWx0ZXIobmFtZSA9PiAhKG91dHB1dC5yZXN1bHRzLnRhYmxlcyB8fCBbXSkuc29tZShyb3cgPT4gcm93LnJlbG5hbWUgPT09IG5hbWUpKTsKICBvdXRwdXQuY29tcGxldGVuZXNzLm1pc3NpbmdDb2x1bW5UYWJsZXMgPSBSRVFVSVJFRF9UQUJMRVMuZmlsdGVyKG5hbWUgPT4gIShvdXRwdXQucmVzdWx0cy5jb2x1bW5zIHx8IFtdKS5zb21lKHJvdyA9PiByb3cudGFibGVfbmFtZSA9PT0gbmFtZSkpOwogIG91dHB1dC5jb21wbGV0ZW5lc3MubWlzc2luZ1NlY3Rpb25zID0gT2JqZWN0LmtleXMoUVVFUklFUykuZmlsdGVyKG5hbWUgPT4gIU9iamVjdC5oYXNPd24ob3V0cHV0LnJlc3VsdHMsIG5hbWUpKTsKICBvdXRwdXQuY29tcGxldGVuZXNzLmNhdGFsb2dDb21wbGV0ZSA9IE9iamVjdC5rZXlzKG91dHB1dC5lcnJvcnMpLmxlbmd0aCA9PT0gMCAmJiBvdXRwdXQuY29tcGxldGVuZXNzLm1pc3NpbmdUYWJsZXMubGVuZ3RoID09PSAwICYmIG91dHB1dC5jb21wbGV0ZW5lc3MubWlzc2luZ1NlY3Rpb25zLmxlbmd0aCA9PT0gMCAmJiBvdXRwdXQuY29tcGxldGVuZXNzLm1pc3NpbmdDb2x1bW5UYWJsZXMubGVuZ3RoID09PSAwICYmICFvdXRwdXQuY29tcGxldGVuZXNzLm1pZ3JhdGlvbkhpc3RvcnlUcnVuY2F0ZWQ7CiAgY29uc3QgcnVudGltZVJvbGUgPSBvdXRwdXQucmVzdWx0cy5lbnZpcm9ubWVudD8uWzBdPy5ydW50aW1lX3JvbGU7CiAgY29uc3Qgcm9sZSA9IChvdXRwdXQucmVzdWx0cy5yb2xlcyB8fCBbXSkuZmluZChyb3cgPT4gcm93LnJvbG5hbWUgPT09IHJ1bnRpbWVSb2xlKTsKICBvdXRwdXQuY29tcGxldGVuZXNzLnJ1bnRpbWVMZWFzdFByaXZpbGVnZSA9ICFyb2xlID8gJ1VOS05PV04nIDogcm9sZS5yb2xzdXBlciB8fCByb2xlLnJvbGJ5cGFzc3JscyB8fCByb2xlLnJvbGNyZWF0ZXJvbGUgfHwgcm9sZS5yb2xjcmVhdGVkYiA/ICdSRVFVSVJFU19SRU1FRElBVElPTl9SRVZJRVcnIDogJ1JPTEVfRkxBR1NfUkVDT1JERURfUkVWSUVXX09CSkVDVF9HUkFOVFMnOwogIG91dHB1dC5zdGF0dXMgPSBvdXRwdXQuY29tcGxldGVuZXNzLmNhdGFsb2dDb21wbGV0ZSAmJiBvdXRwdXQuc3RyaWN0VGxzPy5wb3NpdGl2ZT8udmVyaWZpZWQgJiYgb3V0cHV0LnN0cmljdFRscz8ubmVnYXRpdmVDaGVja3NQYXNzZWQgPyAnRVZJREVOQ0VfQ09MTEVDVEVEX1JFUVVJUkVTX1JFVklFVycgOiAnSU5DT01QTEVURV9CTE9DS0VEJzsKICByZXR1cm4gb3V0cHV0Owp9CmFzeW5jIGZ1bmN0aW9uIHJ1bkNsaSh7Y29sbGVjdEZuID0gY29sbGVjdCwgZGVhZGxpbmVNcyA9IDMwMDAwMH0gPSB7fSkgewogIGxldCBlbWl0dGVkID0gZmFsc2U7CiAgY29uc3QgZW1pdCA9IHJlc3VsdCA9PiB7IGlmIChlbWl0dGVkKSByZXR1cm47IGVtaXR0ZWQgPSB0cnVlOyBwcm9jZXNzLnN0ZG91dC53cml0ZSgnQUVHSVNfUkVBRE9OTFlfRVZJREVOQ0VfQkVHSU5cbicgKyBKU09OLnN0cmluZ2lmeShyZXN1bHQsIG51bGwsIDIpICsgJ1xuQUVHSVNfUkVBRE9OTFlfRVZJREVOQ0VfRU5EXG4nKTsgfTsKICBjb25zdCB0aW1lciA9IHNldFRpbWVvdXQoKCkgPT4geyBlbWl0KHtjb2xsZWN0b3JWZXJzaW9uOjIsc3RhdHVzOidJTkNPTVBMRVRFX0JMT0NLRUQnLGVycm9yczp7Y29sbGVjdG9yOidDT0xMRUNUT1JfREVBRExJTkVfRVhDRUVERUQnfSxwcm9kdWN0aW9uTXV0YXRpb25zOmZhbHNlfSk7IHByb2Nlc3MuZXhpdCgyKTsgfSwgTWF0aC5taW4oMzAwMDAwLCBNYXRoLm1heCgyNSwgTnVtYmVyKGRlYWRsaW5lTXMpIHx8IDMwMDAwMCkpKTsKICB0cnkgeyBjb25zdCByZXN1bHQgPSBhd2FpdCBjb2xsZWN0Rm4oKTsgZW1pdChyZXN1bHQpOyBpZiAocmVzdWx0LnN0YXR1cyAhPT0gJ0VWSURFTkNFX0NPTExFQ1RFRF9SRVFVSVJFU19SRVZJRVcnKSBwcm9jZXNzLmV4aXRDb2RlID0gMjsgfQogIGNhdGNoIHsgZW1pdCh7Y29sbGVjdG9yVmVyc2lvbjoyLHN0YXR1czonSU5DT01QTEVURV9CTE9DS0VEJyxlcnJvcnM6e2NvbGxlY3RvcjonQ09OVFJPTExFRF9DT0xMRUNUSU9OX0ZBSUxVUkUnfSxwcm9kdWN0aW9uTXV0YXRpb25zOmZhbHNlfSk7IHByb2Nlc3MuZXhpdENvZGUgPSAyOyB9CiAgZmluYWxseSB7IGNsZWFyVGltZW91dCh0aW1lcik7IH0KfQptb2R1bGUuZXhwb3J0cyA9IHtjb2xsZWN0LCBydW5DbGksIGF0dGVzdFNvY2tldCwgc3RyaWN0T3B0aW9ucywgUVVFUklFUywgUkVRVUlSRURfVEFCTEVTLCBMRUdBQ1lfREJfU0hBMjU2LCBQVUJMSUNfVU5UUlVTVEVEX0NBfTsKaWYgKHJlcXVpcmUubWFpbiA9PT0gbW9kdWxlKSB2b2lkIHJ1bkNsaSgpOwo='
$AegisExpectedPayloadSha256 = '39118dd89e94551950a1915d434bb4d61189004d2dae8f02ef42c2abf3605db8'
function Resolve-AegisLauncher {
    param([bool]$WindowsMode = ($env:OS -eq 'Windows_NT'))
    # Never pass ExternalScript (.ps1), alias or function to CreateProcess.
    $Names = @('railway')
    if ($WindowsMode) { $Names = @('railway.cmd', 'railway.exe', 'railway') }
    foreach ($Name in $Names) {
        $Candidates = @(Get-Command -Name $Name -CommandType Application -All -ErrorAction SilentlyContinue)
        foreach ($Candidate in $Candidates) {
            $Path = $Candidate.Path
            if (-not $Path -or -not [IO.File]::Exists($Path)) { continue }
            $Extension = [IO.Path]::GetExtension($Path).ToLowerInvariant()
            if ($Extension -eq '.ps1') { continue }
            if ($WindowsMode -and $Extension -eq '.cmd') {
                # cmd performs percent expansion even inside quotes; reject ambiguous paths.
                if ($Path -match '[%!"\r\n]') { throw 'AEGIS_SAFE:UNSUPPORTED_CMD_PATH' }
                return [pscustomobject]@{ Path = $Path; Kind = 'NPM_CMD'; Windows = $true }
            }
            if ($WindowsMode) {
                if ($Extension -and $Extension -ne '.exe') { continue }
                $Stream = [IO.File]::OpenRead($Path)
                try { $IsPe = ($Stream.ReadByte() -eq 77 -and $Stream.ReadByte() -eq 90) }
                finally { $Stream.Dispose() }
                if (-not $IsPe) { continue }
            }
            return [pscustomobject]@{ Path = $Path; Kind = 'NATIVE'; Windows = $WindowsMode }
        }
    }
    throw 'AEGIS_SAFE:RAILWAY_LAUNCHER_UNAVAILABLE'
}
# C# capture avoids ReadToEnd hiding the SSH error until EOF or a blocked stdin write ends.
if (-not ('AegisCaptureV4' -as [type])) {
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.IO;
using System.Diagnostics;
using System.Threading.Tasks;
public class AegisCaptureV4 {
 readonly object gate = new object();
 readonly StringBuilder output = new StringBuilder(), error = new StringBuilder();
 public Task OutTask, ErrTask;
 public bool Limited, ReadFailed;
 public void Start(Process p) { OutTask=Read(p.StandardOutput,output); ErrTask=Read(p.StandardError,error); }
 async Task Read(StreamReader r,StringBuilder b) {
  try { char[] a=new char[1024]; int n;
   while((n=await r.ReadAsync(a,0,a.Length).ConfigureAwait(false))>0) {
    lock(gate) { if(b.Length+n>8388608) {Limited=true;return;} b.Append(a,0,n); }
   }
  } catch {lock(gate) {ReadFailed=true;}}
 }
 public string Out() {lock(gate) {return output.ToString();}}
 public string Err() {lock(gate) {return error.ToString();}}
}
'@
}
function Get-AegisQuotedWord {
 param([string]$Value,[bool]$WindowsMode)
 if ($Value -match '[\r\n\x00]') {throw 'AEGIS_SAFE:UNSAFE_COMMAND_WORD'}
 if ($WindowsMode) {
  if ($Value -match '[%!"\r\n]') {throw 'AEGIS_SAFE:UNSAFE_WINDOWS_COMMAND_WORD'}
  return '"'+$Value+'"'
 }
 $q=[string][char]39; $replacement=$q+[char]34+$q+[char]34+$q
 return $q+$Value.Replace($q,$replacement)+$q
}
function Get-AegisFailureClass {
 param([string]$Out,[string]$Err,[bool]$TimedOut,[int]$ExitCode)
 $Text=$Err+"`n"+$Out
 if($Text -match '(?i)unrecognized subcommand|unexpected argument|Found argument .*wasn.t expected'){return 'CLI_CAPABILITY_UNAVAILABLE'}
 if($Text -match '(?i)Bad owner or permissions|Bad configuration option'){return 'SSH_LOCAL_CONFIGURATION_REJECTED'}
 if($Text -match '(?i)REMOTE HOST IDENTIFICATION HAS CHANGED|Offending .* key'){return 'SSH_HOST_KEY_CHANGED'}
 if($Text -match '(?i)Host key verification failed|No .* host key is known|authenticity of host .* cannot be established'){return 'SSH_HOST_TRUST_REQUIRED'}
 if($Text -match '(?i)No registered SSH keys|No SSH keys found'){return 'SSH_REGISTERED_LOCAL_KEY_REQUIRED'}
 if($Text -match '(?i)Permission denied \(publickey|no supported authentication methods'){return 'SSH_KEY_AUTHENTICATION_DENIED'}
 if($Text -match '(?i)passphrase|sign_and_send_pubkey: signing failed|agent refused operation'){return 'SSH_KEY_UNLOCK_REQUIRED'}
 if($Text -match '(?i)Could not resolve hostname|Name or service not known'){return 'SSH_DNS_FAILED'}
 if($Text -match '(?i)Connection timed out|Connection refused|No route to host|Connection reset'){return 'SSH_CONNECT_FAILED'}
 if($Text -match '(?i)node: not found|node: command not found|exec.*node.*not found'){return 'REMOTE_NODE_UNAVAILABLE'}
 if($TimedOut){return 'TRANSPORT_DEADLINE_EXCEEDED'}
 if($ExitCode -ne 0){return 'PROCESS_EXIT_NONZERO'}
 return 'NO_CONFIRMED_REMOTE_SENTINEL'
}
function Stop-AegisOwnedProcess {
 param($Process)
 if($env:OS -eq 'Windows_NT') {
  $Kill=New-Object Diagnostics.Process
  try {
   $Kill.StartInfo.FileName=Join-Path ([Environment]::SystemDirectory) 'taskkill.exe'
   $Kill.StartInfo.Arguments='/PID '+$Process.Id+' /T /F'
   $Kill.StartInfo.UseShellExecute=$false;$Kill.StartInfo.CreateNoWindow=$true
   $Kill.StartInfo.RedirectStandardOutput=$true;$Kill.StartInfo.RedirectStandardError=$true
   $null=$Kill.Start();$null=$Kill.StandardOutput.ReadToEndAsync();$null=$Kill.StandardError.ReadToEndAsync()
   if(-not $Kill.WaitForExit(3000)){$Kill.Kill()}
  }catch{}finally{$Kill.Dispose()}
 }
 try{if(-not $Process.HasExited){$Process.Kill()}}catch{}
}
function Invoke-AegisTransport {
 param([string]$Executable,[string[]]$Words,[string]$InputText='',[int]$TimeoutMs=30000,[string]$Stage='LOCAL')
 $WindowsMode=$env:OS -eq 'Windows_NT'
 $Remaining=600000-[int]$AegisOverall.ElapsedMilliseconds-10000
 if($Remaining -le 0){throw 'AEGIS_SAFE:TOTAL_BUDGET_EXHAUSTED'}
 $Budget=[Math]::Min($TimeoutMs,$Remaining)
 # OS file-backed stdin gives EOF without waiting for a 25KB+ write into an unread pipe.
 # This local file contains only public collector code or synthetic data, never credentials.
 $InputFile=Join-Path $AegisTemp ([Guid]::NewGuid().ToString('N')+'.stdin')
 $Utf8=New-Object Text.UTF8Encoding($false)
 $Clock=[Diagnostics.Stopwatch]::StartNew()
 [IO.File]::WriteAllText($InputFile,$InputText,$Utf8)
 if($Clock.ElapsedMilliseconds -gt 15000){throw 'AEGIS_SAFE:LOCAL_STDIN_PREPARATION_DEADLINE'}
 $Parts=@((Get-AegisQuotedWord $Executable $WindowsMode))
 foreach($Word in $Words){$Parts+=Get-AegisQuotedWord $Word $WindowsMode}
 $Line=($Parts -join ' ')+' < '+(Get-AegisQuotedWord $InputFile $WindowsMode)
 $Info=New-Object Diagnostics.ProcessStartInfo
 $Info.UseShellExecute=$false;$Info.CreateNoWindow=$true
 $Info.RedirectStandardOutput=$true;$Info.RedirectStandardError=$true
 $Info.StandardOutputEncoding=$Utf8;$Info.StandardErrorEncoding=$Utf8
 if($WindowsMode){$Info.FileName=Join-Path ([Environment]::SystemDirectory) 'cmd.exe';$Info.Arguments='/d /v:off /s /c "'+$Line+'"'}
 else{$Info.FileName='/bin/sh';$Info.Arguments='-c '+[char]34+('exec '+$Line).Replace('\','\\').Replace([string][char]34,'\'+[char]34)+[char]34}
 $Process=New-Object Diagnostics.Process;$Process.StartInfo=$Info
 $Capture=New-Object AegisCaptureV4;$Started=$false;$TimedOut=$false;$ExitCode=-1
 try {
  try{$Started=$Process.Start()}catch{throw 'AEGIS_SAFE:PROCESS_START_FAILED'}
  if(-not $Started){throw 'AEGIS_SAFE:PROCESS_START_FAILED'}
  $Capture.Start($Process)
  while(-not $Process.WaitForExit(100)) {
   if($Capture.Limited){break}
   if($Clock.ElapsedMilliseconds -ge $Budget){$TimedOut=$true;break}
  }
  if($TimedOut -or $Capture.Limited){Stop-AegisOwnedProcess $Process}
  try{if($Process.HasExited){$ExitCode=$Process.ExitCode}}catch{}
  foreach($Task in @($Capture.OutTask,$Capture.ErrTask)) {
   $Wait=[Math]::Max(1,[Math]::Min(3000,$Budget-[int]$Clock.ElapsedMilliseconds))
   if(-not $Task.Wait($Wait)){$TimedOut=$true}
  }
  $Out=$Capture.Out();$Err=$Capture.Err()
  $Class=Get-AegisFailureClass $Out $Err $TimedOut $ExitCode
  $Entry=[ordered]@{stage=$Stage;elapsedMs=[int]$Clock.ElapsedMilliseconds;budgetMs=$Budget;stdinBytes=$Utf8.GetByteCount($InputText);stdinMode='OS_FILE_BACKED_EOF';stdoutChars=$Out.Length;stderrChars=$Err.Length;exitCode=$ExitCode;timedOut=$TimedOut;classification=$Class;sshAuthenticated=($Err -match '(?i)Authenticated to ');hostKeyMatched=($Err -match '(?i)known and matches|Found key in ')}
  $AegisReport.stages.Add([pscustomobject]$Entry)
  if($Capture.Limited){throw 'AEGIS_SAFE:CAPTURE_LIMIT_EXCEEDED'}
  if($Capture.ReadFailed){throw 'AEGIS_SAFE:CAPTURE_READ_FAILED'}
  return [pscustomobject]@{Out=$Out;Err=$Err;Code=$ExitCode;TimedOut=$TimedOut;Class=$Class}
 }finally{
  if($Started){try{if(-not $Process.HasExited){Stop-AegisOwnedProcess $Process}}catch{}}
  $Process.Dispose();$Clock.Stop();[IO.File]::Delete($InputFile)
 }
}
function Assert-AegisResult {
 param($Result,[string]$Expected)
 if($Result.TimedOut -or $Result.Code -ne 0){throw ('AEGIS_SAFE:'+$Result.Class)}
 if($Expected -and $Result.Out.Trim() -ne $Expected){throw 'AEGIS_SAFE:REMOTE_SENTINEL_MISSING_OR_CHANGED'}
 $Last=$AegisReport.stages[$AegisReport.stages.Count-1]
 $Last.classification='PASS_PROCESS_EXIT_ONLY'
 if($Expected){$Last.classification='PASS_EXPECTED_REMOTE_SENTINEL'}
}
function Write-AegisJsonFile {
 param([string]$Name,$Value)
 $Path=Join-Path $OutputDirectory ($Name+'-'+[DateTime]::UtcNow.ToString('yyyyMMddTHHmmssfffZ')+'-'+[Guid]::NewGuid().ToString('N').Substring(0,8)+'.json')
 $Utf8=New-Object Text.UTF8Encoding($false);$Bytes=$Utf8.GetBytes(($Value|ConvertTo-Json -Depth 40))
 $File=[IO.File]::Open($Path,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$File.Write($Bytes,0,$Bytes.Length);$File.Flush()}finally{$File.Dispose()}
 return $Path
}

# MAIN: every network step is read-only; no SSH keys/config/trust are created or changed.
$AegisReport=[ordered]@{procedureVersion=4;mode='READ_ONLY_DIAGNOSTIC_AND_COLLECTION';totalBudgetMs=600000;collectorBudgetMs=300000;stdinPreparationBudgetMs=15000;productionMutations=$false;stages=(New-Object 'System.Collections.Generic.List[object]');status='INCOMPLETE_BLOCKED';failureStage='LOCAL_PREFLIGHT';failureCode=$null}
$AegisTemp=$null;$AegisExit=2
try {
 if(-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)){throw 'AEGIS_SAFE:OUTPUT_DIRECTORY_UNAVAILABLE'}
 $ProbePath=Join-Path $OutputDirectory ('Aegis-write-probe-'+[Guid]::NewGuid().ToString('N')+'.tmp')
 $Probe=[IO.File]::Open($ProbePath,[IO.FileMode]::CreateNew,[IO.FileAccess]::Write,[IO.FileShare]::None)
 try{$Probe.Flush()}finally{$Probe.Dispose();[IO.File]::Delete($ProbePath)}
 $AegisTemp=Join-Path ([IO.Path]::GetTempPath()) ('Aegis-Readonly-'+[Guid]::NewGuid().ToString('N'))
 $null=[IO.Directory]::CreateDirectory($AegisTemp)
 $AegisBytes=[Convert]::FromBase64String($AegisPayloadBase64)
 $Hash=[Security.Cryptography.SHA256]::Create()
 try{$Actual=([BitConverter]::ToString($Hash.ComputeHash($AegisBytes))).Replace('-','').ToLowerInvariant()}finally{$Hash.Dispose()}
 if($Actual -ne $AegisExpectedPayloadSha256){throw 'AEGIS_SAFE:COLLECTOR_PAYLOAD_HASH_MISMATCH'}
 $AegisReport.collectorSha256=$Actual
 $Launcher=Resolve-AegisLauncher
 $AegisReport.launcherKind=$Launcher.Kind
 $Stage='CLI_VERSION';$AegisReport.failureStage=$Stage
 $Result=Invoke-AegisTransport $Launcher.Path @('--version') '' 15000 $Stage
 Assert-AegisResult $Result ''
 if($Result.Out -notmatch '(?im)^railway\s+v?([0-9]+\.[0-9]+\.[0-9]+)'){throw 'AEGIS_SAFE:CLI_VERSION_INVALID'}
 $AegisReport.railwayVersion=$Matches[1]
 $Stage='CLI_AUTH';$AegisReport.failureStage=$Stage
 $Result=Invoke-AegisTransport $Launcher.Path @('whoami','--json') '' 30000 $Stage
 Assert-AegisResult $Result '';$null=$Result.Out|ConvertFrom-Json
 $Stage='REGISTERED_KEY_INVENTORY';$AegisReport.failureStage=$Stage
 $Result=Invoke-AegisTransport $Launcher.Path @('ssh','keys','list') '' 45000 $Stage
 Assert-AegisResult $Result ''
 $RegisteredSection=''
 if($Result.Out -match '(?ms)^Registered (?:Workspace )?SSH Keys:\r?\n(.*?)(?=^[^\s]|\z)'){$RegisteredSection=$Matches[1]}
 $Registered=@([regex]::Matches($RegisteredSection,'(?m)^\s*Fingerprint:\s+(SHA256:[A-Za-z0-9+/]{20,64})')|ForEach-Object {$_.Groups[1].Value})
 $AegisReport.registeredFingerprintCount=@($Registered).Count
 if(@($Registered).Count -eq 0){throw 'AEGIS_SAFE:SSH_REGISTERED_KEY_REQUIRED'}
 $AegisReport.failureStage='OPENSSH_LOCAL_PREFLIGHT'
 $SshCandidates=@(Get-Command -Name ssh -CommandType Application -All -ErrorAction SilentlyContinue|Where-Object {$_.Path -notmatch '\.(ps1|cmd|bat)$'})
 $KeyCandidates=@(Get-Command -Name ssh-keygen -CommandType Application -All -ErrorAction SilentlyContinue|Where-Object {$_.Path -notmatch '\.(ps1|cmd|bat)$'})
 if($SshCandidates.Count -eq 0 -or $KeyCandidates.Count -eq 0){throw 'AEGIS_SAFE:OPENSSH_TOOLS_UNAVAILABLE'}
 $Ssh=$SshCandidates[0];$Keygen=$KeyCandidates[0]
 $Result=Invoke-AegisTransport $Ssh.Path @('-V') '' 15000 'OPENSSH_LOCAL_VERSION'
 Assert-AegisResult $Result ''
 if($Result.Err -match '(OpenSSH[^,\s]+)'){$AegisReport.openSshVersion=$Matches[1]}
 $AegisIdentity=$null
 $PubDirectory=Join-Path $HOME '.ssh'
 foreach($Pub in @(Get-ChildItem -LiteralPath $PubDirectory -Filter '*.pub' -File -ErrorAction SilentlyContinue)) {
  $Private=$Pub.FullName.Substring(0,$Pub.FullName.Length-4)
  if(-not [IO.File]::Exists($Private)){continue}
  $Result=Invoke-AegisTransport $Keygen.Path @('-l','-E','sha256','-f',$Pub.FullName) '' 10000 'LOCAL_PUBLIC_KEY_MATCH'
  if($Result.Code -eq 0 -and $Result.Out -match 'SHA256:[A-Za-z0-9+/]{20,64}' -and $Registered -contains $Matches[0]){$AegisIdentity=$Private;break}
 }
 # Agent-only registered keys may still authenticate; no private key is read or exported here.
 $AegisReport.localRegisteredFileMatch=($null -ne $AegisIdentity)
 $Stage='TARGET_RESOLUTION_DRY_RUN';$AegisReport.failureStage=$Stage
 $Result=Invoke-AegisTransport $Launcher.Path @('ssh','config','--dry-run','--project','0233d8e5-8437-4d94-ad0c-3f24deb1902e','--environment','aa887588-a793-47b7-b789-df297f78ef8d','--service','75a4edb0-86fb-4fb6-b7d7-3f88880503ec') '' 45000 $Stage
 Assert-AegisResult $Result ''
 if($Result.Out -notmatch '(?im)^\s*HostName\s+ssh\.railway\.com\s*$'){throw 'AEGIS_SAFE:UNEXPECTED_SSH_RELAY'}
 if($Result.Out -notmatch '(?im)^\s*User\s+([0-9a-fA-F-]{36})\s*$'){throw 'AEGIS_SAFE:TARGET_RESOLUTION_INVALID'}
 $Target=$Matches[1]
 $Port='22';if($Result.Out -match '(?im)^\s*Port\s+(\d+)\s*$'){$Port=$Matches[1]}
 if($Port -ne '22'){throw 'AEGIS_SAFE:UNEXPECTED_SSH_RELAY_PORT'}
 $SshWords=@('-T','-v','-o','BatchMode=yes','-o','ForwardAgent=no','-o','ClearAllForwardings=yes','-o','PermitLocalCommand=no','-o','ControlMaster=no','-o','ControlPath=none','-o','StrictHostKeyChecking=yes','-o','UpdateHostKeys=no','-o','ConnectTimeout=15','-o','ConnectionAttempts=1','-o','ServerAliveInterval=15','-o','ServerAliveCountMax=2')
 if($AegisIdentity){$SshWords+=@('-i',$AegisIdentity,'-o','IdentitiesOnly=yes')}
 $SshWords+=@('-l',$Target,'ssh.railway.com')
 $Nonce='730000000'+(Get-Random -Minimum 100000 -Maximum 999999).ToString()
 $Stage='SSH_HOST_AUTH_REMOTE_NODE';$AegisReport.failureStage=$Stage
 $Result=Invoke-AegisTransport $Ssh.Path ($SshWords+@('node','--no-warnings','-p',$Nonce)) '' 45000 $Stage
 Assert-AegisResult $Result $Nonce
 $AegisReport.strictNoninteractiveSsh='PASS_REMOTE_NODE_NONCE'
 $Small='console.log("AEGIS_SMALL_'+$Nonce+'");'
 $Stage='REMOTE_STDIN_SMALL';$AegisReport.failureStage=$Stage
 $Result=Invoke-AegisTransport $Ssh.Path ($SshWords+@('node','--no-warnings')) $Small 45000 $Stage
 Assert-AegisResult $Result ('AEGIS_SMALL_'+$Nonce)
 $Bootstrap='const b=Buffer.from("'+$AegisPayloadBase64+'","base64");if(require("crypto").createHash("sha256").update(b).digest("hex")!=="'+$Actual+'")process.exit(2);const m={exports:{}};new Function("require","module","exports",b.toString("utf8"))(require,m,m.exports);m.exports.runCli({deadlineMs:300000});'
 $Large='console.log("AEGIS_LARGE_'+$Nonce+'");/*'
 $Large=$Large+('x'*($Bootstrap.Length-$Large.Length-2))+'*/'
 $AegisReport.syntheticPayloadBytes=$Large.Length
 $AegisReport.collectorTransportBytes=$Bootstrap.Length
 $Stage='REMOTE_STDIN_COLLECTOR_SIZE';$AegisReport.failureStage=$Stage
 $Result=Invoke-AegisTransport $Ssh.Path ($SshWords+@('node','--no-warnings')) $Large 75000 $Stage
 Assert-AegisResult $Result ('AEGIS_LARGE_'+$Nonce)
 # Only after all harmless probes pass may the real read-only collector run.
 if(600000-$AegisOverall.ElapsedMilliseconds -lt 340000){throw 'AEGIS_SAFE:INSUFFICIENT_REMAINING_COLLECTOR_BUDGET'}
 $Stage='READ_ONLY_COLLECTOR';$AegisReport.failureStage=$Stage
 $Result=Invoke-AegisTransport $Ssh.Path ($SshWords+@('node','--no-warnings')) $Bootstrap 330000 $Stage
 $Start='AEGIS_READONLY_EVIDENCE_BEGIN';$End='AEGIS_READONLY_EVIDENCE_END'
 if(([regex]::Matches($Result.Out,$Start)).Count -ne 1 -or ([regex]::Matches($Result.Out,$End)).Count -ne 1){throw ('AEGIS_SAFE:'+$Result.Class)}
 $a=$Result.Out.IndexOf($Start)+$Start.Length;$b=$Result.Out.IndexOf($End)
 if($b -le $a){throw 'AEGIS_SAFE:COLLECTOR_MARKERS_INVALID'}
 $Evidence=$Result.Out.Substring($a,$b-$a).Trim()|ConvertFrom-Json
 if($Evidence.collectorVersion -ne 2 -or $Evidence.productionMutations -ne $false -or @('EVIDENCE_COLLECTED_REQUIRES_REVIEW','INCOMPLETE_BLOCKED') -notcontains $Evidence.status){throw 'AEGIS_SAFE:COLLECTOR_RECORD_INVALID'}
 $EvidencePath=Write-AegisJsonFile 'AEGIS-Production-Readonly' $Evidence
 Write-Host ('Evidence saved: '+$EvidencePath)
 $AegisReport.status=$Evidence.status
 if($Result.Code -eq 0 -and -not $Result.TimedOut -and $Evidence.status -eq 'EVIDENCE_COLLECTED_REQUIRES_REVIEW'){$AegisExit=0;$AegisReport.failureStage=$null}
 else{$AegisReport.failureCode='COLLECTOR_INCOMPLETE_OR_NONZERO'}
}catch{
 $Code='UNEXPECTED_STAGE_FAILURE'
 if($_.Exception.Message -match '^AEGIS_SAFE:([A-Z_]+)$'){$Code=$Matches[1]}
 $AegisReport.failureCode=$Code
 Write-Host ('AEGIS_STOP: '+$AegisReport.failureStage+' / '+$Code)
}finally{
 if($AegisTemp){try{[IO.Directory]::Delete($AegisTemp,$true)}catch{}}
 $AegisReport.elapsedMs=[int]$AegisOverall.ElapsedMilliseconds
 try{$ReportPath=Write-AegisJsonFile 'AEGIS-Transport-Diagnostics-v4' $AegisReport;Write-Host ('Sanitized diagnostics saved: '+$ReportPath)}catch{Write-Host 'AEGIS_STOP: DIAGNOSTIC_EXPORT_FAILED'}
 $AegisOverall.Stop()
}
Write-Host 'Return only generated sanitized JSON files. No raw SSH output, keys, credentials or operational rows.'
exit $AegisExit
